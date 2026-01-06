# ES9018K2M DAC Control Plugin for Volumio

Hardware control plugin for ES9018K2M-based DAC HATs on Raspberry Pi running Volumio.

## Features

- **Automatic Volume Sync** - DAC volume follows Volumio volume control
- **Digital Filters** - FIR filter selection (slow/fast roll-off, minimum phase, bypass)
- **IIR Bandwidth** - Adjustable for PCM and DSD content
- **DPLL Jitter Reduction** - Configurable for I2S and DSD sources
- **Channel Balance** - Fine-tune left/right balance
- **Hardware Pop Prevention** - Optimal register configuration for smooth playback

## Supported Hardware

Works with any ES9018K2M-based DAC HAT, including:

- Aoide DAC II
- Audiophonics I-SABRE ES9018K2M
- TeraDAK ES9018K2M
- Other generic ES9018K2M I2S DAC boards

## Installation

### Step 1: Configure Volumio DAC Output

1. Go to **Volumio Settings > Playback Options**
2. Under **I2S DAC**, select **i2s-dac** (or "Generic I2S DAC")
3. Click **Save**
4. **Reboot** when prompted

### Step 2: Install the Plugin

From Volumio plugin store (if available), or manually:

```bash
git clone --depth=1 https://github.com/foonerd/es9018k2m-plugin.git
cd es9018k2m-plugin
volumio plugin install
```

### Step 3: Enable and Configure

1. Go to **Volumio Settings > Plugins > Installed Plugins**
2. Enable **ES9018K2M DAC Control**
3. Click **Settings** to configure filters, DPLL, and balance

## Configuration

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

### Register Configuration

The plugin initializes the DAC with optimal register settings derived from ESS application notes and the ES9038Q2M reference implementation:

| Register | Value | Function |
|----------|-------|----------|
| 0x0E | 0x8A | Soft-start: ramps to AVCC/2 on lock changes (pop prevention) |
| 0x01 | 0xC4 | 32-bit I2S, auto-detect serial/DSD |
| 0x06 | 0x47 | Volume ramp rate: fastest |
| 0x0C | 0x5F | DPLL: I2S=5, DSD=15 |

### Why No Custom Overlay?

This plugin uses the standard `i2s-dac` overlay because:

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

### Pops or Clicks

The hardware soft-start (register 0x0E) should prevent pops. If you still hear them:

1. Try increasing DPLL value
2. Check power supply quality
3. Some very old recordings with DC offset may still cause minor clicks

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
