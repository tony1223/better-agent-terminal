#!/usr/bin/env bash
set -e

REPO="tony1223/better-agent-terminal"
APP_NAME="BetterAgentTerminal"

echo "Installing $APP_NAME..."

# Detect OS and Architecture
OS_TYPE="$(uname -s)"
ARCH_TYPE="$(uname -m)"

case "$OS_TYPE" in
    Darwin*)  OS="macOS" ;;
    Linux*)   OS="Linux" ;;
    MINGW*|MSYS*|CYGWIN*) OS="Windows" ;;
    *)        OS="Unknown" ;;
esac

if [ "$OS" = "Unknown" ]; then
    echo "Error: Unsupported operating system: $OS_TYPE"
    exit 1
fi

echo "Detected OS: $OS ($ARCH_TYPE)"

echo "Fetching latest release information from GitHub..."
RELEASE_DATA=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")

if [ "$OS" = "macOS" ]; then
    # Parse out the macOS .dmg download URL
    DOWNLOAD_URL=$(echo "$RELEASE_DATA" | grep -oE '"browser_download_url": "[^"]+\.dmg"' | head -n 1 | cut -d '"' -f 4)
    if [ -z "$DOWNLOAD_URL" ]; then
        echo "Error: Could not find a macOS .dmg release."
        exit 1
    fi
    
    echo "Downloading macOS app from: $DOWNLOAD_URL"
    TMP_DIR=$(mktemp -d)
    DMG_PATH="$TMP_DIR/$APP_NAME.dmg"
    
    curl -fL "$DOWNLOAD_URL" -o "$DMG_PATH"
    
    echo "Mounting DMG..."
    MOUNT_INFO=$(hdiutil attach "$DMG_PATH" -nobrowse -noverify)
    MOUNT_POINT=$(echo "$MOUNT_INFO" | grep -o '/Volumes/.*' | head -n 1)
    
    if [ -z "$MOUNT_POINT" ]; then
        echo "Error: Failed to find mount point for DMG."
        exit 1
    fi
    
    INSTALL_DIR="/Applications"
    if [ ! -w "/Applications" ]; then
        INSTALL_DIR="$HOME/Applications"
        mkdir -p "$INSTALL_DIR"
        echo "/Applications is not writable. Installing to $INSTALL_DIR instead..."
    fi
    
    echo "Installing $APP_NAME.app to $INSTALL_DIR..."
    if [ -d "$INSTALL_DIR/$APP_NAME.app" ]; then
        rm -rf "$INSTALL_DIR/$APP_NAME.app"
    fi
    
    cp -R "$MOUNT_POINT/$APP_NAME.app" "$INSTALL_DIR/"
    
    echo "Unmounting DMG..."
    hdiutil detach "$MOUNT_POINT" -force
    
    echo "Cleaning up..."
    rm -rf "$TMP_DIR"
    
    echo "Installation complete!"
    echo "You can now launch $APP_NAME from your $INSTALL_DIR folder."

elif [ "$OS" = "Linux" ]; then
    # Map the host arch to the published AppImage asset. The x64 AppImage keeps
    # its historical arch-less name; arm64 carries a "-arm64" marker. Other
    # arches have no prebuilt AppImage, so fail fast instead of downloading an
    # unrunnable binary ("cannot execute binary file: Exec format error").
    # See: https://github.com/tony1223/better-agent-terminal/issues/113
    case "$ARCH_TYPE" in
        x86_64|amd64)  LINUX_ARCH="x64" ;;
        aarch64|arm64) LINUX_ARCH="arm64" ;;
        *)
            echo "Error: No prebuilt Linux $APP_NAME AppImage is available for '$ARCH_TYPE'." >&2
            echo "Build from source instead: https://github.com/$REPO#option-4-build-from-source" >&2
            exit 1
            ;;
    esac

    # Select the AppImage matching this architecture.
    APPIMAGE_URLS=$(echo "$RELEASE_DATA" | grep -oE '"browser_download_url": "[^"]+\.AppImage"' | cut -d '"' -f 4)
    if [ "$LINUX_ARCH" = "arm64" ]; then
        DOWNLOAD_URL=$(printf '%s\n' "$APPIMAGE_URLS" | grep -E '[-_]arm64\.AppImage$' | head -n 1)
    else
        # x64 has no arch marker in its name; exclude any arm64/aarch64 assets.
        DOWNLOAD_URL=$(printf '%s\n' "$APPIMAGE_URLS" | grep -vE '[-_](arm64|aarch64)(\.lightweight)?\.AppImage$' | head -n 1)
    fi
    if [ -z "$DOWNLOAD_URL" ]; then
        echo "Error: Could not find a Linux $LINUX_ARCH .AppImage in the latest release." >&2
        echo "(The latest release may not include a $LINUX_ARCH build yet.)" >&2
        exit 1
    fi
    
    INSTALL_DIR="$HOME/.local/bin"
    mkdir -p "$INSTALL_DIR"
    
    DEST_PATH="$INSTALL_DIR/better-agent-terminal"
    
    echo "Downloading Linux AppImage from: $DOWNLOAD_URL"
    curl -fL "$DOWNLOAD_URL" -o "$DEST_PATH"
    
    echo "Making it executable..."
    chmod +x "$DEST_PATH"
    
    echo "Installation complete!"
    echo "The AppImage has been installed to $DEST_PATH."
    if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
        echo "Note: $INSTALL_DIR is not in your PATH. You may want to add it to your ~/.bashrc."
    fi

elif [ "$OS" = "Windows" ]; then
    # For Windows in Bash (Git Bash / MSYS), we download the -win.zip
    DOWNLOAD_URL=$(echo "$RELEASE_DATA" | grep -oE '"browser_download_url": "[^"]+-win\.zip"' | head -n 1 | cut -d '"' -f 4)
    if [ -z "$DOWNLOAD_URL" ]; then
        # Fallback to any .zip
        DOWNLOAD_URL=$(echo "$RELEASE_DATA" | grep -oE '"browser_download_url": "[^"]+\.zip"' | head -n 1 | cut -d '"' -f 4)
    fi
    
    if [ -z "$DOWNLOAD_URL" ]; then
        echo "Error: Could not find a Windows .zip release."
        exit 1
    fi
    
    INSTALL_DIR="$HOME/AppData/Local/BetterAgentTerminal"
    mkdir -p "$INSTALL_DIR"
    
    echo "Downloading Windows zip from: $DOWNLOAD_URL"
    TMP_ZIP=$(mktemp --suffix=.zip 2>/dev/null || mktemp)
    curl -fL "$DOWNLOAD_URL" -o "$TMP_ZIP"
    
    echo "Extracting to $INSTALL_DIR..."
    # Use unzip (standard in Git Bash)
    unzip -q -o "$TMP_ZIP" -d "$INSTALL_DIR"
    
    echo "Cleaning up..."
    rm "$TMP_ZIP"
    
    echo "Installation complete!"
    echo "The application has been installed to $INSTALL_DIR."
    echo "You can launch it by running: $INSTALL_DIR/$APP_NAME.exe"
    
    # Optional: try to create a desktop shortcut if in Git Bash
    if [ -d "$HOME/Desktop" ]; then
        echo "Note: You can find the executable at $INSTALL_DIR/$APP_NAME.exe"
    fi
fi
