'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var exec = require('child_process').exec;
var execSync = require('child_process').execSync;
var io = require('socket.io-client');

module.exports = ControllerES9018K2M;

function ControllerES9018K2M(context) {
  var self = this;

  self.context = context;
  self.commandRouter = self.context.coreCommand;
  self.logger = self.context.logger;
  self.configManager = self.context.configManager;

  // I2C configuration
  self.i2cBus = 1;
  self.i2cAddress = 0x48;

  // Device state
  self.deviceFound = false;

  // State tracking
  self.lastVolume = null;
  self.lastStatus = null;
  self.lastSeek = null;
  self.seekMuteMs = 150;
  self.debugLogging = false;

  // Balance offsets
  self.lBal = 0;
  self.rBal = 0;

  // Register shadows
  self.reg7 = 0x80;   // General settings (mute, filters)
  self.reg12 = 0x5A;  // DPLL settings
  self.reg21 = 0x00;  // GPIO and OSF bypass

  // Timing constants
  self.I2C_THROTTLE_MS = 30;
  self.lastI2cWrite = 0;

  // Socket.io state
  self.volumioSocket = null;
  self.socketConnected = false;
  self.reconnectAttempts = 0;
  self.maxReconnectDelay = 30000;
  self.reconnectTimer = null;
  self.socketFailedSince = null;
  self.fallbackPoller = null;

  // Seek intercept state
  self.originalSeek = null;
  self.seekInterceptInstalled = false;
}

// ---------------------------------------------------------------------------
// Volumio Lifecycle
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.onVolumioStart = function() {
  var self = this;
  var configFile = self.commandRouter.pluginManager.getConfigurationFile(
    self.context, 'config.json'
  );

  self.config = new (require('v-conf'))();
  self.config.loadFile(configFile);

  return libQ.resolve();
};

ControllerES9018K2M.prototype.onStart = function() {
  var self = this;
  var defer = libQ.defer();

  self.logger.info('ES9018K2M: Starting plugin');

  self.loadI18nStrings();
  self.loadConfig();

  self.checkDevice()
    .then(function(found) {
      self.deviceFound = found;
      if (found) {
        self.initDevice();
        self.applySettings();
        self.installSeekIntercept();
        self.startVolumeSync();
        self.startSocketConnection();
        self.logger.info('ES9018K2M: Device initialized, socket connection started');
      } else {
        self.logger.warn('ES9018K2M: Device not found at address 0x' +
          self.i2cAddress.toString(16));
      }
      defer.resolve();
    })
    .fail(function(err) {
      self.logger.error('ES9018K2M: Startup failed: ' + err);
      defer.resolve();
    });

  return defer.promise;
};

ControllerES9018K2M.prototype.onStop = function() {
  var self = this;
  var defer = libQ.defer();

  self.logger.info('ES9018K2M: Stopping plugin');

  // Remove seek intercept first
  self.removeSeekIntercept();

  // Stop socket connection
  self.stopSocketConnection();

  // Stop volume sync callback
  self.stopVolumeSync();

  // Mute DAC before stopping
  if (self.deviceFound) {
    self.setMuteSync(true);
  }

  defer.resolve();
  return defer.promise;
};

ControllerES9018K2M.prototype.onVolumioShutdown = function() {
  var self = this;
  self.removeSeekIntercept();
  if (self.deviceFound) {
    self.setMuteSync(true);
  }
  return libQ.resolve();
};

ControllerES9018K2M.prototype.onVolumioReboot = function() {
  var self = this;
  self.removeSeekIntercept();
  if (self.deviceFound) {
    self.setMuteSync(true);
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
  var self = this;

  self.i2cBus = self.config.get('i2cBus', 1);
  self.i2cAddress = self.config.get('i2cAddress', 0x48);
  self.seekMuteMs = self.config.get('seekMuteMs', 150);
  self.debugLogging = self.config.get('debugLogging', false);

  self.lBal = 0;
  self.rBal = 0;
  var balance = self.config.get('balance', 0);
  if (balance > 0) {
    self.lBal = balance;
  } else if (balance < 0) {
    self.rBal = -balance;
  }
};

ControllerES9018K2M.prototype.logDebug = function(msg) {
  var self = this;
  if (self.debugLogging) {
    self.logger.info(msg);
  }
};

ControllerES9018K2M.prototype.saveConfig = function() {
  var self = this;

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
  var self = this;
  var defer = libQ.defer();
  var langCode = self.commandRouter.sharedVars.get('language_code');

  self.commandRouter.i18nJson(
    __dirname + '/i18n/strings_' + langCode + '.json',
    __dirname + '/i18n/strings_en.json',
    __dirname + '/UIConfig.json'
  )
  .then(function(uiconf) {
    // Section 0: Prerequisites (static text)

    // Section 1: Device Status
    uiconf.sections[1].description = self.deviceFound
      ? self.getI18nString('DEVICE_FOUND')
      : self.getI18nString('DEVICE_NOT_FOUND');
    uiconf.sections[1].content[0].value = self.config.get('seekMuteMs', 150);
    uiconf.sections[1].content[1].value = self.config.get('debugLogging', false);

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
// I2C Operations
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.i2cWriteSync = function(register, value) {
  var self = this;

  var cmd = 'i2cset -y ' + self.i2cBus + ' 0x' +
    self.i2cAddress.toString(16) + ' 0x' +
    register.toString(16) + ' 0x' +
    value.toString(16);

  try {
    execSync(cmd, { timeout: 100 });
    return true;
  } catch (err) {
    self.logger.error('ES9018K2M: I2C sync write failed: ' + err.message);
    return false;
  }
};

ControllerES9018K2M.prototype.i2cWrite = function(register, value) {
  var self = this;
  var defer = libQ.defer();

  var now = Date.now();
  var delay = Math.max(0, self.I2C_THROTTLE_MS - (now - self.lastI2cWrite));

  setTimeout(function() {
    var cmd = 'i2cset -y ' + self.i2cBus + ' 0x' +
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
  var self = this;
  var defer = libQ.defer();

  var cmd = 'i2cget -y ' + self.i2cBus + ' 0x' +
    self.i2cAddress.toString(16) + ' 0x' +
    register.toString(16);

  exec(cmd, function(error, stdout, stderr) {
    if (error) {
      self.logger.error('ES9018K2M: I2C read failed: ' + error);
      defer.reject(error);
    } else {
      var value = parseInt(stdout.trim(), 16);
      defer.resolve(value);
    }
  });

  return defer.promise;
};

// ---------------------------------------------------------------------------
// Device Detection and Initialization
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.checkDevice = function() {
  var self = this;
  var defer = libQ.defer();

  self.i2cRead(64)
    .then(function(status) {
      var isES9018K2M = (status & 0x1C) === 0x10;
      if (isES9018K2M) {
        var revision = status & 0x03;
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
  var self = this;

  self.setMuteSync(true);

  // Register 0x00: System settings
  self.i2cWrite(0x00, 0x00);

  // Register 0x01: Input configuration (32-bit I2S, auto-detect)
  self.i2cWrite(0x01, 0xC4);

  // Register 0x04: Automute time
  self.i2cWrite(0x04, 0x10);

  // Register 0x05: Automute level (-104dB)
  self.i2cWrite(0x05, 0x68);

  // Register 0x06: De-emphasis and volume ramp rate
  self.i2cWrite(0x06, 0x47);

  // Register 0x08: GPIO configuration
  self.i2cWrite(0x08, 0x01);

  // Register 0x0C: DPLL/ASRC settings
  self.i2cWrite(0x0C, 0x5F);

  // Register 0x0E: Soft start - KEY FOR POP PREVENTION on format changes
  self.i2cWrite(0x0E, 0x8A);

  // Register 0x15: GPIO and oversampling filter bypass
  self.i2cWrite(0x15, 0x00);

  // Register 0x1B: ASRC and volume latch
  self.i2cWrite(0x1B, 0xD4);

  // Initialize volume to 90%
  self.setVolume(90);

  self.setMuteSync(false);

  self.logger.info('ES9018K2M: Device initialized');
};

ControllerES9018K2M.prototype.applySettings = function() {
  var self = this;

  self.setFirFilter(self.config.get('fir', 1));
  self.setIirFilter(self.config.get('iir', 0));
  self.setDeemphasis(self.config.get('deemphasis', 0x4A));
  self.setDpll(
    self.config.get('i2sDpll', 0x50),
    self.config.get('dsdDpll', 0x0A)
  );
};

// ---------------------------------------------------------------------------
// Seek Intercept - Pre-emptive mute for pop-free seeks
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.installSeekIntercept = function() {
  var self = this;

  if (self.seekInterceptInstalled) {
    return;
  }

  if (typeof self.commandRouter.volumioSeek !== 'function') {
    self.logger.warn('ES9018K2M: volumioSeek not found, seek intercept disabled');
    return;
  }

  // Save original function
  self.originalSeek = self.commandRouter.volumioSeek.bind(self.commandRouter);

  // Install wrapper
  self.commandRouter.volumioSeek = function(position) {
    self.logDebug('ES9018K2M: Seek intercept - position=' + position);

    // Pre-emptive mute (synchronous - blocks until complete)
    if (self.deviceFound && self.seekMuteMs > 0) {
      self.setMuteSync(true);
      self.logDebug('ES9018K2M: Pre-emptive mute applied');
    }

    // Execute original seek
    var result = self.originalSeek(position);

    // Schedule unmute
    if (self.deviceFound && self.seekMuteMs > 0) {
      setTimeout(function() {
        // Check if we should unmute (not user-muted, still playing)
        var state = self.commandRouter.volumioGetState();
        if (state && state.status === 'play' && !state.mute) {
          self.setMuteSync(false);
          self.logDebug('ES9018K2M: Unmuted after seek');
        }
      }, self.seekMuteMs);
    }

    return result;
  };

  self.seekInterceptInstalled = true;
  self.logger.info('ES9018K2M: Seek intercept installed');
};

ControllerES9018K2M.prototype.removeSeekIntercept = function() {
  var self = this;

  if (!self.seekInterceptInstalled || !self.originalSeek) {
    return;
  }

  // Restore original function
  self.commandRouter.volumioSeek = self.originalSeek;
  self.originalSeek = null;
  self.seekInterceptInstalled = false;

  self.logger.info('ES9018K2M: Seek intercept removed');
};

// ---------------------------------------------------------------------------
// Socket.io Connection - Event-driven state tracking
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.startSocketConnection = function() {
  var self = this;

  self.logDebug('ES9018K2M: Starting socket.io connection');

  self.connectSocket();
};

ControllerES9018K2M.prototype.connectSocket = function() {
  var self = this;

  // Clean up existing connection
  if (self.volumioSocket) {
    self.volumioSocket.removeAllListeners();
    self.volumioSocket.close();
    self.volumioSocket = null;
  }

  // Connect to local Volumio backend
  self.volumioSocket = io.connect('http://localhost:3000', {
    reconnection: false,  // We handle reconnection ourselves
    timeout: 5000
  });

  self.volumioSocket.on('connect', function() {
    self.socketConnected = true;
    self.reconnectAttempts = 0;
    self.socketFailedSince = null;

    self.logDebug('ES9018K2M: Socket connected');

    // Stop fallback poller if running
    self.stopFallbackPoller();

    // Request initial state
    self.volumioSocket.emit('getState', '');
  });

  self.volumioSocket.on('pushState', function(state) {
    self.logDebug('ES9018K2M: pushState received - status=' + state.status +
      ' volume=' + state.volume + ' seek=' + state.seek);

    self.handleStateChange(state);
  });

  self.volumioSocket.on('disconnect', function() {
    self.socketConnected = false;
    self.logDebug('ES9018K2M: Socket disconnected');
    self.scheduleReconnect();
  });

  self.volumioSocket.on('connect_error', function(err) {
    self.socketConnected = false;
    self.logDebug('ES9018K2M: Socket connect_error: ' + err.message);
    self.scheduleReconnect();
  });

  self.volumioSocket.on('error', function(err) {
    self.logDebug('ES9018K2M: Socket error: ' + err.message);
  });
};

ControllerES9018K2M.prototype.scheduleReconnect = function() {
  var self = this;

  if (self.reconnectTimer) {
    return;  // Already scheduled
  }

  self.reconnectAttempts++;

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
  var delay = Math.min(
    1000 * Math.pow(2, self.reconnectAttempts - 1),
    self.maxReconnectDelay
  );

  self.logDebug('ES9018K2M: Scheduling reconnect in ' + delay + 'ms (attempt ' +
    self.reconnectAttempts + ')');

  // Track when socket first failed
  if (!self.socketFailedSince) {
    self.socketFailedSince = Date.now();
  }

  // Start fallback poller if socket has been down for >5 minutes
  if (Date.now() - self.socketFailedSince > 300000) {
    self.startFallbackPoller();
  }

  self.reconnectTimer = setTimeout(function() {
    self.reconnectTimer = null;
    self.connectSocket();
  }, delay);
};

ControllerES9018K2M.prototype.stopSocketConnection = function() {
  var self = this;

  if (self.reconnectTimer) {
    clearTimeout(self.reconnectTimer);
    self.reconnectTimer = null;
  }

  self.stopFallbackPoller();

  if (self.volumioSocket) {
    self.volumioSocket.removeAllListeners();
    self.volumioSocket.close();
    self.volumioSocket = null;
  }

  self.socketConnected = false;
  self.logger.info('ES9018K2M: Socket connection stopped');
};

// ---------------------------------------------------------------------------
// Fallback Poller - Only used if socket fails for extended period
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.startFallbackPoller = function() {
  var self = this;

  if (self.fallbackPoller) {
    return;  // Already running
  }

  self.logger.warn('ES9018K2M: Socket unavailable, starting fallback poller (60s interval)');

  self.fallbackPoller = setInterval(function() {
    var state = self.commandRouter.volumioGetState();
    if (state) {
      self.handleStateChange(state);
    }
  }, 60000);  // 60 seconds - minimal impact
};

ControllerES9018K2M.prototype.stopFallbackPoller = function() {
  var self = this;

  if (self.fallbackPoller) {
    clearInterval(self.fallbackPoller);
    self.fallbackPoller = null;
    self.logDebug('ES9018K2M: Fallback poller stopped');
  }
};

// ---------------------------------------------------------------------------
// Volume Sync - Direct callback (no socket needed)
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.startVolumeSync = function() {
  var self = this;

  // Get initial state
  var state = self.commandRouter.volumioGetState();
  if (state) {
    self.logDebug('ES9018K2M: Initial state - status=' + state.status +
      ' volume=' + state.volume);
    self.handleStateChange(state);
  }

  // Register callback for volume changes (most direct path)
  self.volumeCallback = function(volume) {
    self.logDebug('ES9018K2M: Volume callback: ' + JSON.stringify(volume));

    if (typeof volume === 'object' && typeof volume.vol === 'number') {
      if (volume.vol !== self.lastVolume) {
        self.setVolume(volume.vol);
        self.lastVolume = volume.vol;
      }
      if (typeof volume.mute === 'boolean') {
        // Only apply mute if playing - don't override seek mute
        var state = self.commandRouter.volumioGetState();
        if (state && state.status === 'play') {
          self.setMuteSync(volume.mute);
        }
      }
    }
  };

  self.commandRouter.addCallback('volumioupdatevolume', self.volumeCallback);
  self.logger.info('ES9018K2M: Volume sync started');
};

ControllerES9018K2M.prototype.stopVolumeSync = function() {
  var self = this;

  // Note: Volumio doesn't have removeCallback, but setting to null prevents action
  self.volumeCallback = null;
  self.logger.info('ES9018K2M: Volume sync stopped');
};

// ---------------------------------------------------------------------------
// State Change Handler
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.handleStateChange = function(state) {
  var self = this;

  if (!self.deviceFound || !state) {
    return;
  }

  var status = state.status;
  var volume = state.volume;
  var mute = state.mute;

  // Status change handling
  if (status !== self.lastStatus) {
    self.logDebug('ES9018K2M: Status change: ' + self.lastStatus + ' -> ' + status);

    if (status === 'stop' || status === 'pause') {
      if (self.lastStatus === 'play') {
        self.setMuteSync(true);
      }
    } else if (status === 'play') {
      if (self.lastStatus !== 'play' && !mute) {
        self.setMuteSync(false);
      }
    }
    self.lastStatus = status;
  }

  // Volume sync from state (backup path)
  if (typeof volume === 'number' && volume !== self.lastVolume) {
    self.setVolume(volume);
    self.lastVolume = volume;
  }
};

// ---------------------------------------------------------------------------
// DAC Control Functions
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.setVolume = function(vol) {
  var self = this;

  var DAC_MAX_GAIN = 0x00;
  var DAC_MIN_GAIN = 0x63;
  var DAC_MUTE_GAIN = 0xFF;

  var attenuation;
  if (vol <= 0) {
    attenuation = DAC_MUTE_GAIN;
  } else {
    attenuation = Math.round(DAC_MIN_GAIN - (vol * DAC_MIN_GAIN / 100));
  }

  var leftAtten = Math.min(255, attenuation + self.lBal);
  self.i2cWrite(0x0F, leftAtten);

  var rightAtten = Math.min(255, attenuation + self.rBal);
  self.i2cWrite(0x10, rightAtten);
};

ControllerES9018K2M.prototype.setMute = function(mute) {
  var self = this;

  if (mute) {
    self.reg7 = self.reg7 | 0x01;
  } else {
    self.reg7 = self.reg7 & 0xFE;
  }

  self.i2cWrite(0x07, self.reg7);
};

ControllerES9018K2M.prototype.setMuteSync = function(mute) {
  var self = this;

  if (mute) {
    self.reg7 = self.reg7 | 0x01;
  } else {
    self.reg7 = self.reg7 & 0xFE;
  }

  self.i2cWriteSync(0x07, self.reg7);
};

ControllerES9018K2M.prototype.setBalance = function(balance) {
  var self = this;

  self.lBal = 0;
  self.rBal = 0;

  if (balance > 0) {
    self.lBal = Math.min(balance, 40);
  } else if (balance < 0) {
    self.rBal = Math.min(-balance, 40);
  }

  self.config.set('balance', balance);

  if (self.lastVolume !== null) {
    self.setVolume(self.lastVolume);
  }
};

ControllerES9018K2M.prototype.setFirFilter = function(mode) {
  var self = this;

  self.reg7 = self.reg7 & 0x9F;
  self.reg21 = self.reg21 & 0xFE;

  switch (mode) {
    case 0:
      self.reg7 = self.reg7 | 0x20;
      break;
    case 1:
      break;
    case 2:
      self.reg7 = self.reg7 | 0x40;
      break;
    case 3:
      self.reg21 = self.reg21 | 0x01;
      break;
  }

  self.i2cWrite(0x07, self.reg7);
  self.i2cWrite(0x15, self.reg21);
  self.config.set('fir', mode);
};

ControllerES9018K2M.prototype.setIirFilter = function(mode) {
  var self = this;

  self.reg7 = self.reg7 & 0xF3;
  self.reg21 = self.reg21 & 0xFB;

  switch (mode) {
    case 0:
      break;
    case 1:
      self.reg7 = self.reg7 | 0x04;
      break;
    case 2:
      self.reg7 = self.reg7 | 0x08;
      break;
    case 3:
      self.reg7 = self.reg7 | 0x0C;
      break;
    case 4:
      self.reg21 = self.reg21 | 0x04;
      break;
  }

  self.i2cWrite(0x07, self.reg7);
  self.i2cWrite(0x15, self.reg21);
  self.config.set('iir', mode);
};

ControllerES9018K2M.prototype.setDeemphasis = function(mode) {
  var self = this;

  self.i2cWrite(0x06, mode);
  self.config.set('deemphasis', mode);
};

ControllerES9018K2M.prototype.setDpll = function(i2sValue, dsdValue) {
  var self = this;

  self.reg12 = (i2sValue & 0xF0) | (dsdValue & 0x0F);
  self.i2cWrite(0x0C, self.reg12);

  self.config.set('i2sDpll', i2sValue);
  self.config.set('dsdDpll', dsdValue);
};

// ---------------------------------------------------------------------------
// UI Action Handlers
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.checkDeviceStatus = function() {
  var self = this;

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

ControllerES9018K2M.prototype.saveDeviceSettings = function(data) {
  var self = this;

  var seekMuteMs = parseInt(data.seekMuteMs, 10) || 150;
  self.seekMuteMs = Math.max(0, Math.min(2000, seekMuteMs));
  self.config.set('seekMuteMs', self.seekMuteMs);

  self.debugLogging = data.debugLogging || false;
  self.config.set('debugLogging', self.debugLogging);

  self.commandRouter.pushToastMessage('success',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('SETTINGS_SAVED'));
};

ControllerES9018K2M.prototype.saveI2cSettings = function(data) {
  var self = this;

  self.i2cBus = parseInt(data.i2cBus, 10) || 1;

  var addr = data.i2cAddress;
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

  self.checkDeviceStatus();
};

ControllerES9018K2M.prototype.saveBalanceSettings = function(data) {
  var self = this;

  var balance = parseInt(data.balance, 10) || 0;
  self.setBalance(balance);

  self.commandRouter.pushToastMessage('success',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('SETTINGS_SAVED'));
};

ControllerES9018K2M.prototype.resetBalance = function() {
  var self = this;

  self.setBalance(0);

  self.commandRouter.pushToastMessage('success',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('BALANCE_RESET'));
};

ControllerES9018K2M.prototype.saveFilterSettings = function(data) {
  var self = this;

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
  var self = this;

  var i2sValue = (data.i2sDpll && data.i2sDpll.value) || 0x50;
  var dsdValue = (data.dsdDpll && data.dsdDpll.value) || 0x0A;

  self.setDpll(i2sValue, dsdValue);

  self.commandRouter.pushToastMessage('success',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('SETTINGS_SAVED'));
};

ControllerES9018K2M.prototype.resetDevice = function() {
  var self = this;

  if (!self.deviceFound) {
    self.commandRouter.pushToastMessage('warning',
      self.getI18nString('PLUGIN_NAME'),
      self.getI18nString('DEVICE_NOT_FOUND'));
    return;
  }

  self.config.set('balance', 0);
  self.config.set('fir', 1);
  self.config.set('iir', 0);
  self.config.set('deemphasis', 0x4A);
  self.config.set('i2sDpll', 0x50);
  self.config.set('dsdDpll', 0x0A);
  self.config.set('seekMuteMs', 150);
  self.config.set('debugLogging', false);

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
  var options = [
    { value: 0, label: 'Slow Roll-Off' },
    { value: 1, label: 'Fast Roll-Off' },
    { value: 2, label: 'Minimum Phase' },
    { value: 3, label: 'Bypass' }
  ];
  return options.find(function(o) { return o.value === value; }) || options[1];
};

ControllerES9018K2M.prototype.getIirOption = function(value) {
  var options = [
    { value: 0, label: '47K (PCM)' },
    { value: 1, label: '50K (DSD)' },
    { value: 2, label: '60K (DSD)' },
    { value: 3, label: '70K (DSD)' },
    { value: 4, label: 'Bypass' }
  ];
  return options.find(function(o) { return o.value === value; }) || options[0];
};

ControllerES9018K2M.prototype.getDeemphasisOption = function(value) {
  var options = [
    { value: 0x4A, label: 'Off' },
    { value: 0x0A, label: '32 kHz' },
    { value: 0x1A, label: '44.1 kHz' },
    { value: 0x2A, label: '48 kHz' }
  ];
  return options.find(function(o) { return o.value === value; }) || options[0];
};

ControllerES9018K2M.prototype.getDpllOption = function(value) {
  var level = (value >= 0x10) ? (value >> 4) : value;
  var labels = ['Off', '1', '2', '3', '4', '5', '6', '7',
                '8', '9', '10', '11', '12', '13', '14', '15'];
  return { value: value, label: labels[level] || 'Unknown' };
};

// ---------------------------------------------------------------------------
// I18n
// ---------------------------------------------------------------------------

ControllerES9018K2M.prototype.loadI18nStrings = function() {
  var self = this;
  var langCode = self.commandRouter.sharedVars.get('language_code');

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
  var self = this;

  if (self.i18nStrings && self.i18nStrings[key] !== undefined) {
    return self.i18nStrings[key];
  }
  if (self.i18nStringsDefaults && self.i18nStringsDefaults[key] !== undefined) {
    return self.i18nStringsDefaults[key];
  }
  return key;
};
