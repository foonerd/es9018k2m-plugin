# ES9018K2M DAC Control Plugin for Volumio

Hardware control plugin for ES9018K2M-based DAC HATs on Raspberry Pi running Volumio 4.

## Features

- **Hardware Volume Mode** - Enables volume slider even with Mixer Type: None
- **Graceful Volume Ramping** - Smooth fade in/out eliminates audible pops and clicks
- **Pop-Free Seeks** - Pre-emptive mute prevents audio discontinuities
- **Digital Filters** - FIR/IIR filter selection
- **DPLL Jitter Reduction** - Configurable for I2S and DSD sources
- **Channel Balance** - Fine-tune left/right balance

## Supported Hardware

- Aoide DAC II
- Audiophonics I-SABRE ES9018K2M
- TeraDAK ES9018K2M
- Other generic ES9018K2M I2S DAC boards

## Quick Start

### 1. Configure Volumio DAC Output

1. Go to **Volumio Settings > Playback Options**
2. Under **I2S DAC**, select **i2s-dac** (or "Generic I2S DAC")
3. Click **Save** and **Reboot**

### 2. Install the Plugin

```bash
git clone --depth=1 https://github.com/foonerd/es9018k2m-plugin.git
cd es9018k2m-plugin
volumio plugin install
```

### 3. Enable the Plugin

1. Go to **Volumio Settings > Plugins > Installed Plugins**
2. Enable **ES9018K2M DAC Control**

## Common Tasks

### Get Volume Slider Working

If you don't see a volume slider:

1. Open plugin settings
2. Set **Volume Control Mode** to "Hardware (Override)"
3. Save - slider should appear immediately

### Stop Pops and Clicks

**During seeks:**
- Increase **Seek Mute Duration** to 200-300ms

**During play/pause:**
- Enable **Graceful Play/Pause/Stop**
- Increase **Graceful Ramp Steps** to 4 or 5

**During volume changes:**
- Enable **Graceful Volume Changes**

### Adjust Sound Signature

- **FIR Filter**: Try "Minimum Phase" for less pre-ringing
- **DPLL**: Higher values = more jitter reduction (start with 5 for I2S)

## Configuration Reference

| Setting | Default | Description |
|---------|---------|-------------|
| Volume Control Mode | Software | Hardware mode enables slider with Mixer Type: None |
| ALSA Card Number | auto | Manual override for multi-card setups |
| Seek Mute Duration | 150ms | Time to mute during seeks (0 to disable) |
| Graceful Ramp Steps | 3 | Steps for volume fade (1-5, more = smoother) |
| Graceful Play/Pause/Stop | On | Fade on playback state changes |
| Graceful Volume Changes | On | Fade on volume adjustments >5% |
| I2C Bus | 1 | Usually 1 for Raspberry Pi |
| I2C Address | 0x48 | Try 0x49, 0x4A, 0x4B if not detected |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No volume slider | Set Volume Mode to "Hardware (Override)" |
| Device not detected | Check I2C address, verify i2s-dac selected in Playback Options |
| Pops during seek | Increase Seek Mute Duration |
| Pops on play/pause | Enable Graceful Play/Pause/Stop, increase steps |
| Pops on volume change | Enable Graceful Volume Changes |
| Slider jumps back | Enable Debug Logging, check journalctl for errors |

## Technical Details

For architecture, register configuration, and implementation details, see [TECHNICAL.md](TECHNICAL.md).

## Changelog

### v1.2.1
- Hardware Volume Override mode
- Graceful volume ramping for all transitions
- Configurable ramp steps (1-5)
- Auto-detect or manual ALSA card selection

### v1.2.0
- Event-driven architecture with socket.io
- Pre-emptive seek mute via commandRouter intercept

### v1.1.1
- Fixed chip ID detection
- Fixed volume range (0-49.5dB)

## Credits

- **Audiophonics** - Serial sync reference
- **Chris Song** - Original plugin concept
- **Darmur** - Register configuration and volume override discovery
- **Grey_bird** - I2C control implementation
- **luoyi** - Kernel driver reference

## License

MIT License
