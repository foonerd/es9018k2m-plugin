#!/bin/bash

echo "Installing ES9018K2M DAC Control Plugin"
echo ""

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd -P)"

# Check if i2c-tools is available (should be in Volumio base image)
if ! command -v i2cset &> /dev/null; then
  echo "Installing i2c-tools..."
  apt-get update -q
  apt-get install -y i2c-tools
fi

# Install device tree overlays to /boot/overlays
if [ -d "$PLUGIN_DIR/overlays" ]; then
  echo "Installing device tree overlays..."
  
  # Remount boot partition read-write
  mount -o remount,rw /boot 2>/dev/null
  
  # Copy overlay files
  for dtbo in "$PLUGIN_DIR/overlays/"*.dtbo; do
    if [ -f "$dtbo" ]; then
      cp "$dtbo" /boot/overlays/
      echo "  Installed: $(basename "$dtbo")"
    fi
  done
  
  echo ""
  echo "Overlays installed to /boot/overlays/"
fi

echo ""
echo "=========================================="
echo "ES9018K2M DAC Control Plugin installed"
echo "=========================================="
echo ""
echo "IMPORTANT: Setup requires two steps:"
echo ""
echo "STEP 1: Configure ALSA/Mixer (if not done already)"
echo "  - Go to Volumio Settings > Playback Options"
echo "  - Select 'i2s-dac' as I2S DAC"
echo "  - Set your preferred mixer type"
echo "  - Save and Reboot"
echo ""
echo "STEP 2: Configure ES9018K2M overlay"
echo "  - Open this plugin's settings"
echo "  - Select your board type (Type A or Type B)"
echo "  - Click 'Apply and Reboot'"
echo ""
echo "After both steps, the plugin will be fully operational."
echo ""

echo "plugininstallend"
