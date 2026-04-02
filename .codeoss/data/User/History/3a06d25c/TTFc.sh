#!/bin/bash

# 1. Ensure we are in the correct project directory
cd /home/perrymckay1 || exit 1

# 2. Install base project dependencies from package.json
echo "Installing base dependencies..."
npm install

# 3. Install build tools and frontend libraries that esbuild needs to bundle
echo "Ensuring required build and frontend modules are installed..."
npm install esbuild dotenv i18next i18next-chained-backend i18next-localstorage-backend i18next-http-backend

# 4. Run the build script
node build.js