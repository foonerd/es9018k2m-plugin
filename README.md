# ES9018K2M DAC Control Plugin for Volumio

Hardware control plugin for ES9018K2M DAC via I2C with automatic volume synchronization.

## Features

- Automatic volume synchronization with Volumio
- Mute-on-track-change to prevent audio pops
- Digital filter selection (FIR: Slow/Fast/Minimum Phase/Bypass)
- IIR filter bandwidth control
- De-emphasis filter for vintage CDs
- DPLL jitter reduction settings
- Channel balance adjustment
- Fixed 64FS bitclock overlay to prevent bit-depth switching issues

## Installation

### From GitHub (Manual Install)

```bash
git clone --depth=1 https://github.com/foonerd/es9018k2m-plugin.git
cd es9018k2m-plugin
volumio plugin install
```

After installation, follow the Setup Workflow below.

## Setup Workflow

### Step 1: Configure ALSA/Mixer in Volumio

Before using this plugin, you must first configure a DAC in Volumio to establish the ALSA mixer:

1. Go to Volumio Settings > Playback Options > I2S DAC
2. Select "i2s-dac" (or "Generic I2S DAC")
3. Set mixer type (Hardware, Software, or None)
4. Save and Reboot

This step is required to enable ALSA and mixer control infrastructure.

### Step 2: Configure ES9018K2M Overlay

1. Open plugin settings (Settings > Plugins > Installed Plugins > ES9018K2M DAC Control)
2. The plugin will detect your current DAC overlay
3. Select your board type:
   - Type A: Boards WITHOUT onboard crystal (needs MCLK from Pi)
   - Type B: Boards WITH onboard crystal (self-clocked)
4. Click "Apply and Reboot"

### Step 3: Use the Plugin

After reboot:
1. Verify device is detected in plugin status
2. Configure I2C settings if needed (default: bus 1, address 0x48)
3. Adjust filters, DPLL, and balance as desired

## Board Types

### Type A - No Onboard Crystal

Boards that require MCLK signal from Raspberry Pi GPIO4. The overlay configures the Pi to output a master clock signal.

Examples: Some AOIDE DAC boards, generic ES9018K2M modules without oscillator

### Type B - Has Onboard Crystal

Boards with their own clock oscillator that generate MCLK internally.

Examples: Most commercial ES9018K2M DAC HATs with onboard oscillator

## How It Works

### Fixed 64FS Bitclock

This plugin replaces the standard i2s-dac or hifiberry-dac overlay with an ES9018K2M-specific overlay that uses fixed 64FS (64 x sample rate) bitclock ratio.

With fixed 64FS:
- 16-bit audio is zero-padded to 32-bit
- 24-bit audio is zero-padded to 32-bit  
- 32-bit audio plays natively

The DAC always sees a consistent 32-bit I2S stream, eliminating format switching that causes pops and clicks.

### Overlay Management

The plugin modifies /boot/config.txt to replace the existing DAC overlay:
- Detects current overlay (i2s-dac, hifiberry-dac, etc.)
- Replaces it with es9018k2m-type-a or es9018k2m-type-b
- Preserves ALSA/mixer configuration established in Step 1

### I2C Communication

The plugin uses i2c-tools (i2cset/i2cget) for DAC register access. This avoids native Node.js modules and ensures compatibility across Volumio updates.

Default I2C address: 0x48 (configurable in settings)

### Volume Synchronization

The plugin connects to Volumio's WebSocket interface and synchronizes volume changes directly to DAC registers 0x0F (left) and 0x10 (right).

### Mute-on-Track-Change

When a track change is detected, the plugin briefly mutes the DAC (150ms) to allow the audio stream to stabilize before unmuting.

## Troubleshooting

### "No DAC overlay detected" message

You need to configure a DAC in Volumio first:
1. Go to Settings > Playback Options > I2S DAC
2. Select "i2s-dac"
3. Save and Reboot
4. Return to plugin settings

### "Incompatible DAC overlay" message

A DAC overlay other than i2s-dac or hifiberry-dac is configured. Change to i2s-dac in Playback Options and reboot.

### Device not detected after configuration

1. Verify I2C is enabled: `sudo i2cdetect -y 1`
2. Check wiring (SDA, SCL, GND, 3.3V)
3. Verify I2C address matches plugin settings
4. Ensure system was rebooted after overlay change

### No audio

1. Verify correct board type is selected
2. Check ALSA sees the device: `aplay -l`
3. Ensure volume is not muted
4. Check mixer type in Playback Options

### Clicks on track change

Should be handled automatically by mute-on-change. If clicks persist, the mute delay may need adjustment for your specific board.

## Credits

This plugin builds upon work by:

- Chris Song (@ChrisPanda) - Original ES9018K2M plugin for Volumio
- Grey_bird / DanyHovard (@DanyHovard) - WebSocket volume synchronization concept
- Darmur - Fixed 64FS bitclock recommendation

## License

MIT License

## Changelog

### 1.0.0
- Initial release
- Integrated volume synchronization (no Python/systemd service required)
- Mute-on-track-change for click prevention
- Fixed 64FS device tree overlays
- Uses i2c-tools (no native module compilation)
- Overlay management via /boot/config.txt
- State detection and user guidance
