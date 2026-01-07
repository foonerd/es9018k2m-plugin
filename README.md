# ES9018K2M DAC Control Plugin for Volumio

Hardware control plugin for ES9018K2M-based DAC HATs on Raspberry Pi running Volumio 4.

## Features

- **Automatic Volume Sync** - DAC volume follows Volumio volume control via direct callback
- **Event-Driven State Tracking** - Socket.io connection to Volumio backend for play/pause/stop
- **Pop-Free Seeks** - Pre-emptive mute before seek execution prevents audio discontinuities
- **Digital Filters** - FIR filter selection (slow/fast roll-off, minimum phase, bypass)
- **IIR Bandwidth** - Adjustable for PCM and DSD content
- **DPLL Jitter Reduction** - Configurable for I2S and DSD sources
- **Channel Balance** - Fine-tune left/right balance
- **Hardware Soft-Start** - Register 0x0E configuration for format change pop prevention
- **Debug Logging** - Optional verbose logging for troubleshooting

## Supported Hardware

Works with any ES9018K2M-based DAC HAT, including:

- Aoide DAC II
- Audiophonics I-SABRE ES9018K2M
- TeraDAK ES9018K2M
- Other generic ES9018K2M I2S DAC boards

## Requirements

- Volumio 4.x (Bookworm-based)
- Raspberry Pi with I2C enabled
- ES9018K2M-based DAC HAT

## Installation

### Step 1: Configure Volumio DAC Output

1. Go to **Volumio Settings > Playback Options**
2. Under **I2S DAC**, select **i2s-dac** (or "Generic I2S DAC")
3. Click **Save**
4. **Reboot** when prompted

### Step 2: Install the Plugin

From Volumio plugin store (if available), or manually:

```bash
git clone --depth=1 -b dev-websocket https://github.com/foonerd/es9018k2m-plugin.git
cd es9018k2m-plugin
volumio plugin install
```

### Step 3: Enable and Configure

1. Go to **Volumio Settings > Plugins > Installed Plugins**
2. Enable **ES9018K2M DAC Control**
3. Click **Settings** to configure filters, DPLL, and balance

## Configuration

### Device Settings

- **Seek Mute Duration (ms)**: Time to keep DAC muted during seek operations (default: 150ms). Set to 0 to disable seek mute. Higher values ensure pop-free seeks but add slight delay.

- **Debug Logging**: Enable verbose logging for troubleshooting. Logs socket events, state changes, and I2C operations. Disable in normal use to reduce SD card wear.

### I2C Settings

- **I2C Bus**: Usually 1 for Raspberry Pi
- **I2C Address**: Default 0x48 (common alternatives: 0x49, 0x4A, 0x4B)

### Digital Filters

- **FIR Filter**: Controls the oversampling filter shape
  - Fast Roll-Off (default) - sharp cutoff, some pre-ringing
  - Slow Roll-Off - gentler cutoff, less pre-ringing
  - Minimum Phase - no pre-ringing, asymmetric impulse response
  - Bypass - disables oversampling filter

- **IIR Bandwidth**: Analog filter bandwidth
  - 47K - recommended for PCM
  - 50K/60K/70K - options for DSD content
  - Bypass - disables IIR filter

- **De-emphasis**: For pre-emphasized recordings (rare, usually leave Off)

### DPLL Settings

Digital Phase-Locked Loop for jitter reduction:

- **I2S DPLL**: Level 5 is a good starting point
- **DSD DPLL**: Level 10 recommended for DSD

Higher values = more jitter reduction but may cause issues with some sources.

## Technical Details

### Architecture

The plugin uses three mechanisms for DAC control:

1. **Volume Callback** - Registers with Volumio's volumioupdatevolume callback for immediate volume changes. This is the most direct path with minimal latency.

2. **Socket.io Connection** - Connects to Volumio backend (localhost:3000) to receive pushState events for play/pause/stop status changes. Includes automatic reconnection with exponential backoff (1s to 30s max). Falls back to 60s polling only if socket unavailable for >5 minutes.

3. **Seek Intercept** - Wraps commandRouter.volumioSeek() at runtime to apply pre-emptive mute BEFORE seek executes. This is the only way to prevent seek pops since reactive event handling is always too late.

### Seek Pop Prevention

Audio pops during seeks occur because:

- User releases seek slider
- MPD executes seek immediately (audio discontinuity = pop)
- pushState event fires ~30ms AFTER the pop already happened
- Reactive mute arrives too late

The plugin solves this by intercepting volumioSeek() before it reaches MPD:

- Seek request intercepted
- Synchronous mute via execSync (blocks ~30ms)
- Original seek executes (DAC already muted - no pop)
- Unmute after configurable delay

This adds ~30-50ms latency to seeks but guarantees pop-free operation.

### Register Configuration

The plugin initializes the DAC with optimal register settings:

| Register | Value | Function |
|----------|-------|----------|
| 0x0E | 0x8A | Soft-start: ramps to AVCC/2 on DPLL lock changes |
| 0x01 | 0xC4 | 32-bit I2S, auto-detect serial/DSD |
| 0x06 | 0x47 | Volume ramp rate: fastest |
| 0x07 | 0x80 | General settings (mute control, filters) |
| 0x0C | 0x5F | DPLL: I2S=5, DSD=15 |
| 0x0F/0x10 | variable | Left/right channel volume |

### Why No Custom Overlay?

This plugin uses the standard i2s-dac overlay because:

1. All ES9018K2M HATs have onboard oscillators (no MCLK from Pi needed)
2. Register 0x0E soft-start handles sample rate changes at hardware level
3. No kernel driver needed - I2C control via i2c-tools is sufficient
4. Simpler setup, no overlay compilation required

## Troubleshooting

### Device Not Detected

1. Verify i2s-dac is selected in Volumio Playback Options
2. Reboot after changing DAC selection
3. Check I2C address (try 0x48, 0x49, 0x4A, 0x4B)
4. Verify I2C is enabled: `sudo raspi-config` > Interface Options > I2C

### No Audio

1. Ensure DAC is powered
2. Check Volumio audio output is set correctly
3. Try "Check Device" button in plugin settings

### Pops During Seek

1. Increase Seek Mute Duration to 200-300ms
2. Enable Debug Logging to verify seek intercept is working
3. Check logs for "Seek intercept" messages

### Pops on Track Change

Track changes with format differences (sample rate, bit depth) are handled by hardware soft-start (register 0x0E). If you still hear pops:

1. Try increasing DPLL value
2. Check power supply quality
3. Verify register 0x0E is set to 0x8A in debug logs

### Socket Connection Issues

If debug logs show repeated socket reconnection:

1. This is normal during Volumio restarts
2. Plugin falls back to 60s polling after 5 minutes
3. Volume sync via callback continues working regardless

## Changelog

### v1.2.0
- Event-driven architecture with socket.io pushState
- Pre-emptive seek mute via commandRouter intercept
- Exponential backoff reconnection (1s to 30s)
- Fallback poller only when socket unavailable >5min
- Debug logging toggle with immediate effect

### v1.1.1
- Fixed chip ID detection using bit mask 0x1C
- Replaced socket.io with internal callbacks
- Fixed volume range (0-49.5dB)
- Added seek mute for pop prevention

### v1.1.0
- Simplified architecture
- Removed overlay management
- Added optimal init registers from ES9038Q2M reference

## Credits

This plugin builds upon work and contributions from:

- **Audiophonics** - Serial sync reference implementation
  https://github.com/audiophonics/ES9018K2M_serial_sync

- **Chris Song** - Original volumio-es9018k2m-plugin concept
  https://github.com/ChrisPanda/volumio-es9018k2m-plugin

- **Darmur** - ES9038Q2M optimal register configuration
  https://github.com/Darmur

- **Grey_bird (DanyHovard)** - I2C control implementation
  https://github.com/DanyHovard/es9018k2m_volumio_I2C_control

- **luoyi** - Rpi-ES9018K2M-DAC kernel driver reference
  https://github.com/luoyi/Rpi-ES9018K2M-DAC

## License

MIT License
