const esbuild = require('esbuild');
const fs = require('fs');
require('dotenv').config(); // Load variables from your .env file

// Custom plugin to automatically copy static assets to the dist folder
const copyAssetsPlugin = {
    name: 'copy-assets',
    setup(build) {
        build.onEnd(() => {
            if (!fs.existsSync('dist')) fs.mkdirSync('dist');
            
            const filesToCopy = ['index.html', 'privacy.html', 'service-worker.js', 'manifest.json', 'pwa.js', 'symbol.svg', 'apple-touch-icon.png', 'favicon-32x32.png', 'favicon-16x16.png'];
            filesToCopy.forEach(file => {
                if (fs.existsSync(file)) fs.copyFileSync(file, `dist/${file}`);
            });
            
            if (fs.existsSync('images')) {
                fs.cpSync('images', 'dist/images', { recursive: true });
            }
        });
    },
};

// Perform a one-off build
esbuild.build({
    entryPoints: ['app.js', 'style.css'], // Your entry points
    bundle: true,
    outdir: 'dist',
    minify: true, // Compress the code for production
    sourcemap: false, // Turn off sourcemaps to save space and hide source code
    define: { 
        'process.env.NODE_ENV': '"production"', // Tell libraries (like React/Vue, if used) to optimize
        'process.env.STRIPE_PUBLIC_KEY': JSON.stringify(process.env.STRIPE_PUBLIC_KEY || ''),
        'process.env.PUBLIC_VAPID_KEY': JSON.stringify(process.env.PUBLIC_VAPID_KEY),
        'process.env.MAPBOX_TOKEN': JSON.stringify(process.env.MAPBOX_TOKEN || '')
    },
    plugins: [copyAssetsPlugin],
}).then(() => {
    console.log('⚡ Production build complete! Code is minified and ready.');
}).catch(() => process.exit(1));