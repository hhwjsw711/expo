#!/bin/bash
# Sync Convex types from backend to app

echo "🔄 Syncing Convex types from backend..."

BACKEND_DIR="../reelful-backend/convex/_generated"
APP_DIR="convex/_generated"

if [ ! -d "$BACKEND_DIR" ]; then
  echo "❌ Backend types not found at $BACKEND_DIR"
  echo "   Make sure backend is running: cd ../reelful-backend && bunx convex dev"
  exit 1
fi

# Create directory if it doesn't exist
mkdir -p "$APP_DIR"

# Copy types
cp -r "$BACKEND_DIR"/* "$APP_DIR"/

echo "✅ Types synced successfully!"
echo "   Location: $APP_DIR"

