'use strict';

const libQ = require('kew');
const fs = require('fs-extra');
const { exec } = require('child_process');
const io = require('socket.io-client');

module.exports = ControllerES9018K2M;

function ControllerES9018K2M(context) {
  const self = this;

  self.context = context;
  self.commandRouter = self.context.coreCommand;
  self.logger = self.context.logger;
  self.configManager = self.context.configManager;

  // I2C configuration
  self.i2cBus = 1;
  self.i2cAddress = 0x48;

  // Device state
  self.deviceFound = false;
  self.volumioSocket = null;

  // State tracking for volume sync
  self.lastVolume = null;
  self.lastStatus = null;

  // Balance offsets
  self.lBal = 0;
  self.rBal = 0;

  // Register shadows
  self.reg7 = 0x80;   // General settings (mute, filters)
  self.reg12 = 0x5A;  // DPLL settings
  self.reg21 = 0x00;  // GPIO and OSF bypass

  // Timing constants
  self.I2C_THROTTLE_MS = 30; // Minimum between I2C operations
  self.lastI2cWrite = 0;
}

// ---------------------------------------------------------------------------
// Volumio Lifecycle
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.onVolumioStart = function() {
  const self = this;
  const configFile = self.commandRouter.pluginManager.getConfigurationFile(
    self.context, 'config.json'
  );

  self.config = new (require('v-conf'))();
  self.config.loadFile(configFile);

  return libQ.resolve();
};

ControllerES9018K2M.prototype.onStart = function() {
  const self = this;
  const defer = libQ.defer();

  self.logger.info('ES9018K2M: Starting plugin');

  self.loadI18nStrings();
  self.loadConfig();

  self.checkDevice()
    .then(function(found) {
      self.deviceFound = found;
      if (found) {
        self.initDevice();
        self.applySettings();
        self.startVolumeSync();
        self.logger.info('ES9018K2M: Device initialized and volume sync started');
      } else {
        self.logger.warn('ES9018K2M: Device not found at address 0x' + 
          self.i2cAddress.toString(16));
      }
      defer.resolve();
    })
    .fail(function(err) {
      self.logger.error('ES9018K2M: Startup failed: ' + err);
      defer.resolve(); // Don't block Volumio startup
    });

  return defer.promise;
};

ControllerES9018K2M.prototype.onStop = function() {
  const self = this;
  const defer = libQ.defer();

  self.logger.info('ES9018K2M: Stopping plugin');

  // Stop volume sync
  if (self.volumioSocket) {
    self.volumioSocket.disconnect();
    self.volumioSocket = null;
  }

  // Mute DAC before stopping
  if (self.deviceFound) {
    self.setMute(true);
  }

  defer.resolve();
  return defer.promise;
};

ControllerES9018K2M.prototype.onVolumioShutdown = function() {
  const self = this;
  if (self.deviceFound) {
    self.setMute(true);
  }
  return libQ.resolve();
};

ControllerES9018K2M.prototype.onVolumioReboot = function() {
  const self = this;
  if (self.deviceFound) {
    self.setMute(true);
  }
  return libQ.resolve();
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.getConfigurationFiles = function() {
  return ['config.json'];
};

ControllerES9018K2M.prototype.loadConfig = function() {
  const self = this;

  self.i2cBus = self.config.get('i2cBus', 1);
  self.i2cAddress = self.config.get('i2cAddress', 0x48);

  self.lBal = 0;
  self.rBal = 0;
  const balance = self.config.get('balance', 0);
  if (balance > 0) {
    self.lBal = balance;
  } else if (balance < 0) {
    self.rBal = -balance;
  }
};

ControllerES9018K2M.prototype.saveConfig = function() {
  const self = this;

  self.config.set('i2cBus', self.i2cBus);
  self.config.set('i2cAddress', self.i2cAddress);
  self.config.set('balance', self.config.get('balance', 0));
  self.config.set('fir', self.config.get('fir', 1));
  self.config.set('iir', self.config.get('iir', 0));
  self.config.set('deemphasis', self.config.get('deemphasis', 0x4A));
  self.config.set('i2sDpll', self.config.get('i2sDpll', 0x50));
  self.config.set('dsdDpll', self.config.get('dsdDpll', 0x0A));
};

ControllerES9018K2M.prototype.getUIConfig = function() {
  const self = this;
  const defer = libQ.defer();
  const langCode = self.commandRouter.sharedVars.get('language_code');

  self.commandRouter.i18nJson(
    __dirname + '/i18n/strings_' + langCode + '.json',
    __dirname + '/i18n/strings_en.json',
    __dirname + '/UIConfig.json'
  )
  .then(function(uiconf) {
    // Section 0: Prerequisites (static text, no dynamic content)

    // Section 1: Device Status
    uiconf.sections[1].description = self.deviceFound
      ? self.getI18nString('DEVICE_FOUND')
      : self.getI18nString('DEVICE_NOT_FOUND');

    // Section 2: I2C Settings
    uiconf.sections[2].content[0].value = self.i2cBus;
    uiconf.sections[2].content[1].value = '0x' + self.i2cAddress.toString(16).toUpperCase();

    // Section 3: Balance
    uiconf.sections[3].content[0].value = self.config.get('balance', 0);

    // Section 4: Digital Filters
    uiconf.sections[4].content[0].value = self.getFirOption(self.config.get('fir', 1));
    uiconf.sections[4].content[1].value = self.getIirOption(self.config.get('iir', 0));
    uiconf.sections[4].content[2].value = self.getDeemphasisOption(self.config.get('deemphasis', 0x4A));

    // Section 5: DPLL
    uiconf.sections[5].content[0].value = self.getDpllOption(self.config.get('i2sDpll', 0x50));
    uiconf.sections[5].content[1].value = self.getDpllOption(self.config.get('dsdDpll', 0x0A));

    defer.resolve(uiconf);
  })
  .fail(function(err) {
    self.logger.error('ES9018K2M: getUIConfig failed: ' + err);
    defer.reject(err);
  });

  return defer.promise;
};

// ---------------------------------------------------------------------------
// I2C Operations (via i2c-tools)
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.i2cWrite = function(register, value) {
  const self = this;
  const defer = libQ.defer();

  // Throttle I2C writes
  const now = Date.now();
  const delay = Math.max(0, self.I2C_THROTTLE_MS - (now - self.lastI2cWrite));

  setTimeout(function() {
    const cmd = 'i2cset -y ' + self.i2cBus + ' 0x' + 
      self.i2cAddress.toString(16) + ' 0x' + 
      register.toString(16) + ' 0x' + 
      value.toString(16);

    exec(cmd, function(error, stdout, stderr) {
      self.lastI2cWrite = Date.now();
      if (error) {
        self.logger.error('ES9018K2M: I2C write failed: ' + error);
        defer.reject(error);
      } else {
        defer.resolve();
      }
    });
  }, delay);

  return defer.promise;
};

ControllerES9018K2M.prototype.i2cRead = function(register) {
  const self = this;
  const defer = libQ.defer();

  const cmd = 'i2cget -y ' + self.i2cBus + ' 0x' + 
    self.i2cAddress.toString(16) + ' 0x' + 
    register.toString(16);

  exec(cmd, function(error, stdout, stderr) {
    if (error) {
      self.logger.error('ES9018K2M: I2C read failed: ' + error);
      defer.reject(error);
    } else {
      const value = parseInt(stdout.trim(), 16);
      defer.resolve(value);
    }
  });

  return defer.promise;
};

// ---------------------------------------------------------------------------
// Device Detection and Initialization
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.checkDevice = function() {
  const self = this;
  const defer = libQ.defer();

  // Read status register (64) to detect ES9018K2M
  self.i2cRead(64)
    .then(function(status) {
      // Check chip ID bits (bits 4:2 should be 100 for ES9018K2M)
      const isES9018K2M = (status & 0x1C) === 0x10;
      if (isES9018K2M) {
        const revision = status & 0x03;
        self.logger.info('ES9018K2M: Found device (reg64=0x' + 
          status.toString(16) + ', revision=' + revision + ')');
      }
      defer.resolve(isES9018K2M);
    })
    .fail(function(err) {
      self.logger.error('ES9018K2M: Device detection failed: ' + err);
      defer.resolve(false);
    });

  return defer.promise;
};

ControllerES9018K2M.prototype.initDevice = function() {
  const self = this;

  // Mute during initialization
  self.setMute(true);

  // -------------------------------------------------------------------------
  // Optimal register configuration adapted from ES9038Q2M (Darmur)
  // Register 0x0E is KEY for hardware-level pop prevention during FS changes
  // -------------------------------------------------------------------------

  // Register 0x00: System settings
  // Bit 0: OSC_DRV - oscillator drive strength (0 = normal)
  // Bits 1-7: Reserved
  self.i2cWrite(0x00, 0x00);

  // Register 0x01: Input configuration
  // Bits 7:6 = 11: 32-bit I2S
  // Bits 5:4 = 00: I2S mode
  // Bits 3:2 = 01: auto-detect serial/DSD
  // Bits 1:0 = 00: serial input
  self.i2cWrite(0x01, 0xC4);

  // Register 0x04: Automute time
  // Value 0x10 = ~3s at 44.1kHz, ~0.7s at 192kHz
  self.i2cWrite(0x04, 0x10);

  // Register 0x05: Automute level
  // Value 0x68 = -104dB threshold
  self.i2cWrite(0x05, 0x68);

  // Register 0x06: De-emphasis and volume ramp rate
  // Bit 7: auto_deemph off
  // Bit 6: deemph_bypass disabled
  // Bits 5:4: deemph_sel = 32kHz
  // Bit 3: DoP enable off
  // Bits 2:0: volume_rate = fastest (111)
  self.i2cWrite(0x06, 0x47);

  // Register 0x08: GPIO configuration
  // Bits 7:4 = 0000: GPIO2 = automute status
  // Bits 3:0 = 0001: GPIO1 = lock status
  self.i2cWrite(0x08, 0x01);

  // Register 0x0C: DPLL/ASRC settings
  // Bits 7:4: I2S DPLL bandwidth (default 5)
  // Bits 3:0: DSD DPLL bandwidth (default 15 = max)
  self.i2cWrite(0x0C, 0x5F);

  // Register 0x0E: Soft start configuration - KEY FOR POP PREVENTION
  // Bit 7 = 1: soft_start enabled, ramps to AVCC/2
  // Bit 3 = 1: soft_start_on_lock = always (ramp on DPLL lock/unlock)
  // Bits 2:0 = 010: soft_start_time = default
  // This allows hardware to handle FS changes smoothly without software mute
  self.i2cWrite(0x0E, 0x8A);

  // Register 0x15: GPIO and oversampling filter bypass
  // Bit 0 = 0: Use internal OSF (no bypass)
  // Bit 2 = 0: Use internal IIR (no bypass)
  self.i2cWrite(0x15, 0x00);

  // Register 0x1B (27): ASRC and volume latch
  // Bit 7 = 1: ASRC enabled
  // Bit 6 = 1: sync_volume off
  // Bit 5 = 0: latch_volume on (both channels update together)
  // Bit 4 = 1: 18dB gain off
  self.i2cWrite(0x1B, 0xD4);

  // Initialize volume to 90%
  self.setVolume(90);

  // Unmute after init complete
  self.setMute(false);

  self.logger.info('ES9018K2M: Device initialized with optimal register settings');
};

ControllerES9018K2M.prototype.applySettings = function() {
  const self = this;

  // Apply saved filter settings
  self.setFirFilter(self.config.get('fir', 1));
  self.setIirFilter(self.config.get('iir', 0));
  self.setDeemphasis(self.config.get('deemphasis', 0x4A));

  // Apply DPLL settings
  self.setDpll(
    self.config.get('i2sDpll', 0x50),
    self.config.get('dsdDpll', 0x0A)
  );
};

// ---------------------------------------------------------------------------
// Volume Synchronization
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.startVolumeSync = function() {
  const self = this;

  self.volumioSocket = io.connect('http://localhost:3000');

  self.volumioSocket.on('pushState', function(state) {
    self.handleStateChange(state);
  });

  self.volumioSocket.on('connect', function() {
    self.logger.info('ES9018K2M: Volume sync connected');
    // Request initial state
    self.volumioSocket.emit('getState', '');
  });

  self.volumioSocket.on('disconnect', function() {
    self.logger.warn('ES9018K2M: Volume sync disconnected');
  });
};

ControllerES9018K2M.prototype.handleStateChange = function(state) {
  const self = this;

  if (!self.deviceFound) return;

  const status = state.status;
  const volume = state.volume;
  const mute = state.mute;

  // Status change - mute on stop/pause, unmute on play
  // No track change mute needed - register 0x0E soft start handles pops
  if (status !== 'play' && self.lastStatus === 'play') {
    self.setMute(true);
  } else if (status === 'play' && self.lastStatus !== 'play') {
    if (!mute) {
      self.setMute(false);
    }
  }
  self.lastStatus = status;

  // Volume sync
  if (typeof volume === 'number' && volume !== self.lastVolume) {
    self.setVolume(volume);
    self.lastVolume = volume;
  }

  // Explicit mute control
  if (typeof mute === 'boolean') {
    self.setMute(mute);
  }
};

// ---------------------------------------------------------------------------
// DAC Control Functions
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.setVolume = function(vol) {
  const self = this;

  // ES9018K2M: 0 = 0dB (max), 255 = -127.5dB (mute)
  // Volumio: 0 = min, 100 = max
  const attenuation = Math.round((100 - Math.max(0, Math.min(100, vol))) * 2.55);

  // Left channel (register 15) with balance offset
  const leftAtten = Math.min(255, attenuation + self.lBal);
  self.i2cWrite(0x0F, leftAtten);

  // Right channel (register 16) with balance offset
  const rightAtten = Math.min(255, attenuation + self.rBal);
  self.i2cWrite(0x10, rightAtten);
};

ControllerES9018K2M.prototype.setMute = function(mute) {
  const self = this;

  if (mute) {
    self.reg7 = self.reg7 | 0x01;  // Set bit 0 (mute)
  } else {
    self.reg7 = self.reg7 & 0xFE;  // Clear bit 0 (unmute)
  }

  self.i2cWrite(0x07, self.reg7);
};

ControllerES9018K2M.prototype.setBalance = function(balance) {
  const self = this;

  self.lBal = 0;
  self.rBal = 0;

  if (balance > 0) {
    self.lBal = Math.min(balance, 40);  // Reduce left channel
  } else if (balance < 0) {
    self.rBal = Math.min(-balance, 40); // Reduce right channel
  }

  self.config.set('balance', balance);

  // Re-apply current volume with new balance
  if (self.lastVolume !== null) {
    self.setVolume(self.lastVolume);
  }
};

ControllerES9018K2M.prototype.setFirFilter = function(mode) {
  const self = this;

  // Clear FIR bits (5:6) in reg7
  self.reg7 = self.reg7 & 0x9F;
  // Clear OSF bypass bit in reg21
  self.reg21 = self.reg21 & 0xFE;

  switch (mode) {
    case 0: // Slow roll-off
      self.reg7 = self.reg7 | 0x20;
      break;
    case 1: // Fast roll-off (default)
      // Both bits clear
      break;
    case 2: // Minimum phase
      self.reg7 = self.reg7 | 0x40;
      break;
    case 3: // Bypass oversampling
      self.reg21 = self.reg21 | 0x01;
      break;
  }

  self.i2cWrite(0x07, self.reg7);
  self.i2cWrite(0x15, self.reg21);
  self.config.set('fir', mode);
};

ControllerES9018K2M.prototype.setIirFilter = function(mode) {
  const self = this;

  // Clear IIR bits (2:3) in reg7
  self.reg7 = self.reg7 & 0xF3;
  // Clear IIR bypass bit in reg21
  self.reg21 = self.reg21 & 0xFB;

  switch (mode) {
    case 0: // 47K (PCM default)
      // Both bits clear
      break;
    case 1: // 50K (DSD)
      self.reg7 = self.reg7 | 0x04;
      break;
    case 2: // 60K (DSD)
      self.reg7 = self.reg7 | 0x08;
      break;
    case 3: // 70K (DSD)
      self.reg7 = self.reg7 | 0x0C;
      break;
    case 4: // Bypass
      self.reg21 = self.reg21 | 0x04;
      break;
  }

  self.i2cWrite(0x07, self.reg7);
  self.i2cWrite(0x15, self.reg21);
  self.config.set('iir', mode);
};

ControllerES9018K2M.prototype.setDeemphasis = function(mode) {
  const self = this;

  // Register 6: deemphasis filter
  // 0x4A = off, 0x0A = 32K, 0x1A = 44.1K, 0x2A = 48K
  self.i2cWrite(0x06, mode);
  self.config.set('deemphasis', mode);
};

ControllerES9018K2M.prototype.setDpll = function(i2sValue, dsdValue) {
  const self = this;

  // Register 12: DPLL settings
  // Upper nibble: I2S DPLL, Lower nibble: DSD DPLL
  self.reg12 = (i2sValue & 0xF0) | (dsdValue & 0x0F);
  self.i2cWrite(0x0C, self.reg12);

  self.config.set('i2sDpll', i2sValue);
  self.config.set('dsdDpll', dsdValue);
};

// ---------------------------------------------------------------------------
// UI Action Handlers
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.checkDeviceStatus = function() {
  const self = this;

  self.checkDevice()
    .then(function(found) {
      self.deviceFound = found;
      if (found) {
        self.commandRouter.pushToastMessage('success',
          self.getI18nString('PLUGIN_NAME'),
          self.getI18nString('DEVICE_FOUND'));
      } else {
        self.commandRouter.pushToastMessage('warning',
          self.getI18nString('PLUGIN_NAME'),
          self.getI18nString('DEVICE_NOT_FOUND'));
      }
    });
};

ControllerES9018K2M.prototype.saveI2cSettings = function(data) {
  const self = this;

  self.i2cBus = parseInt(data.i2cBus, 10) || 1;

  // Parse address (handle both "0x48" and "72" formats)
  let addr = data.i2cAddress;
  if (typeof addr === 'string') {
    addr = addr.toLowerCase().startsWith('0x') 
      ? parseInt(addr, 16) 
      : parseInt(addr, 10);
  }
  self.i2cAddress = addr || 0x48;

  self.config.set('i2cBus', self.i2cBus);
  self.config.set('i2cAddress', self.i2cAddress);

  self.commandRouter.pushToastMessage('success',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('SETTINGS_SAVED'));

  // Re-check device with new settings
  self.checkDeviceStatus();
};

ControllerES9018K2M.prototype.saveBalanceSettings = function(data) {
  const self = this;

  const balance = parseInt(data.balance, 10) || 0;
  self.setBalance(balance);

  self.commandRouter.pushToastMessage('success',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('SETTINGS_SAVED'));
};

ControllerES9018K2M.prototype.resetBalance = function() {
  const self = this;

  self.setBalance(0);

  self.commandRouter.pushToastMessage('success',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('BALANCE_RESET'));
};

ControllerES9018K2M.prototype.saveFilterSettings = function(data) {
  const self = this;

  if (data.fir && data.fir.value !== undefined) {
    self.setFirFilter(data.fir.value);
  }
  if (data.iir && data.iir.value !== undefined) {
    self.setIirFilter(data.iir.value);
  }
  if (data.deemphasis && data.deemphasis.value !== undefined) {
    self.setDeemphasis(data.deemphasis.value);
  }

  self.commandRouter.pushToastMessage('success',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('SETTINGS_SAVED'));
};

ControllerES9018K2M.prototype.saveDpllSettings = function(data) {
  const self = this;

  const i2sValue = (data.i2sDpll && data.i2sDpll.value) || 0x50;
  const dsdValue = (data.dsdDpll && data.dsdDpll.value) || 0x0A;

  self.setDpll(i2sValue, dsdValue);

  self.commandRouter.pushToastMessage('success',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('SETTINGS_SAVED'));
};

ControllerES9018K2M.prototype.resetDevice = function() {
  const self = this;

  if (!self.deviceFound) {
    self.commandRouter.pushToastMessage('warning',
      self.getI18nString('PLUGIN_NAME'),
      self.getI18nString('DEVICE_NOT_FOUND'));
    return;
  }

  // Reset to defaults
  self.config.set('balance', 0);
  self.config.set('fir', 1);
  self.config.set('iir', 0);
  self.config.set('deemphasis', 0x4A);
  self.config.set('i2sDpll', 0x50);
  self.config.set('dsdDpll', 0x0A);

  self.loadConfig();
  self.initDevice();
  self.applySettings();

  self.commandRouter.pushToastMessage('success',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('DEVICE_RESET'));
};

// ---------------------------------------------------------------------------
// Option Helpers for UI
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.getFirOption = function(value) {
  const options = [
    { value: 0, label: 'Slow Roll-Off' },
    { value: 1, label: 'Fast Roll-Off' },
    { value: 2, label: 'Minimum Phase' },
    { value: 3, label: 'Bypass' }
  ];
  return options.find(function(o) { return o.value === value; }) || options[1];
};

ControllerES9018K2M.prototype.getIirOption = function(value) {
  const options = [
    { value: 0, label: '47K (PCM)' },
    { value: 1, label: '50K (DSD)' },
    { value: 2, label: '60K (DSD)' },
    { value: 3, label: '70K (DSD)' },
    { value: 4, label: 'Bypass' }
  ];
  return options.find(function(o) { return o.value === value; }) || options[0];
};

ControllerES9018K2M.prototype.getDeemphasisOption = function(value) {
  const options = [
    { value: 0x4A, label: 'Off' },
    { value: 0x0A, label: '32 kHz' },
    { value: 0x1A, label: '44.1 kHz' },
    { value: 0x2A, label: '48 kHz' }
  ];
  return options.find(function(o) { return o.value === value; }) || options[0];
};

ControllerES9018K2M.prototype.getDpllOption = function(value) {
  // DPLL values are 0x00, 0x10, 0x20, ... 0xF0 for I2S (upper nibble)
  // and 0x00, 0x01, 0x02, ... 0x0F for DSD (lower nibble)
  const level = (value >= 0x10) ? (value >> 4) : value;
  const labels = ['Off', '1', '2', '3', '4', '5', '6', '7', 
                  '8', '9', '10', '11', '12', '13', '14', '15'];
  return { value: value, label: labels[level] || 'Unknown' };
};

// ---------------------------------------------------------------------------
// I18n
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.loadI18nStrings = function() {
  const self = this;
  const langCode = self.commandRouter.sharedVars.get('language_code');

  try {
    self.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_' + langCode + '.json');
  } catch (e) {
    self.i18nStrings = {};
  }

  try {
    self.i18nStringsDefaults = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
  } catch (e) {
    self.i18nStringsDefaults = {};
  }
};

ControllerES9018K2M.prototype.getI18nString = function(key) {
  const self = this;

  if (self.i18nStrings && self.i18nStrings[key] !== undefined) {
    return self.i18nStrings[key];
  }
  if (self.i18nStringsDefaults && self.i18nStringsDefaults[key] !== undefined) {
    return self.i18nStringsDefaults[key];
  }
  return key;
};
