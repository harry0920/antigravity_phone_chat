#!/bin/bash

echo "==================================================="
echo "  Antigravity Phone Connect - Global Installer"
echo "==================================================="

# Define target directories
GLOBAL_DIR="$HOME/Anti Gravity Projects/Global_Phone_Connect"
BIN_DIR="$HOME/.local/bin"

# 1. Create the global directory
echo "📦 Moving Phone Connect to Global Directory..."
mkdir -p "$GLOBAL_DIR"

# 2. Copy the contents of this folder to the global directory
cp -R ./* "$GLOBAL_DIR/"
cp -R ./.* "$GLOBAL_DIR/" 2>/dev/null || true # Copy hidden files like .env

echo "✅ Moved to: $GLOBAL_DIR"

# 3. Create the global 'ag' wrapper command
echo "⚙️  Setting up global 'agr' (Antigravity Remote) command..."
mkdir -p "$BIN_DIR"

cat << 'EOF' > "$BIN_DIR/agr"
#!/bin/bash
# Antigravity wrapper that automatically assigns an available debugging port
# Usage: agr .
#        agr /path/to/project

BASE_PORT=9000
MAX_PORT=9010
TARGET_PORT=$BASE_PORT

# Find an open port
while netstat -an | grep "\.$TARGET_PORT " | grep -q LISTEN; do
    ((TARGET_PORT++))
    if [ $TARGET_PORT -gt $MAX_PORT ]; then
        echo "❌ Error: All debugging ports from $BASE_PORT to $MAX_PORT are in use."
        exit 1
    fi
done

echo "🚀 Launching Antigravity with Remote Debugging on port $TARGET_PORT..."
antigravity "$@" --remote-debugging-port=$TARGET_PORT &
EOF

chmod +x "$BIN_DIR/agr"

# 4. Update ZSHRC if necessary
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo "Updating ~/.zshrc to include $BIN_DIR in PATH..."
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
    echo "⚠️  Please run 'source ~/.zshrc' or restart your terminal after this script."
fi

# 5. Create a background service start script
cat << EOF > "$BIN_DIR/phone-connect-server"
#!/bin/bash
cd "$GLOBAL_DIR"
./start_ag_phone_connect_web.sh
EOF

chmod +x "$BIN_DIR/phone-connect-server"

echo "==================================================="
echo "🎉 Global Installation Complete!"
echo "==================================================="
echo "To use your new global setup:"
echo "1. Open any workspace using: agr ."
echo "   (This automatically adds the debugging port so the phone can connect)"
echo ""
echo "2. Start your phone server from anywhere by typing:"
echo "   phone-connect-server"
echo "==================================================="
