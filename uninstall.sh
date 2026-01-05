#!/bin/bash

echo "Uninstalling ES9018K2M DAC Control Plugin"
echo ""

# Note: We do NOT modify /boot/config.txt on uninstall
# The user should reconfigure their DAC in Volumio Playback Options
# after uninstalling this plugin

echo "=========================================="
echo "ES9018K2M DAC Control Plugin uninstalled"
echo "=========================================="
echo ""
echo "NOTE: The ES9018K2M overlay entry in /boot/config.txt"
echo "has NOT been removed automatically."
echo ""
echo "To restore normal operation:"
echo "  1. Go to Volumio Settings > Playback Options"
echo "  2. Select your preferred I2S DAC (e.g., 'i2s-dac')"
echo "  3. Save and Reboot"
echo ""
echo "The overlay files in /boot/overlays/ have been left"
echo "in place in case you reinstall the plugin."
echo ""

echo "pluginuninstallend"
