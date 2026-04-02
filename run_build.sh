#!/bin/bash

# 1. Ensure we are in the correct project directory
cd /home/perrymckay1 || exit 1

# 2. Install base project dependencies from package.json
echo "Installing base dependencies..."
npm install

# 3. Run the build script
node build.js