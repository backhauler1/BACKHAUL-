#!/bin/bash

# 1. Ensure we are in the correct project directory
cd /home/perrymckay1 || exit 1

# 2. Install the specific dependencies required by build.js
echo "Checking and installing build dependencies..."
npm install esbuild dotenv

# 3. Run the build script
node build.js