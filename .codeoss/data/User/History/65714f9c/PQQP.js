const esbuild = require('esbuild');
const fs = require('fs');
require('dotenv').config(); // Load variables from your .env file

// Custom plugin to automatically copy static files to the dist folder
const copyHtmlPlugin = {
    name: 'copy-html',
    setup(build) {
        build.onEnd(() => {
            if (fs.existsSync('index.html')) {
                if (!fs.existsSync('dist')) fs.mkdirSync('dist');
                fs.copyFileSync('index.html', 'dist/index.html');
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
        'process.env.STRIPE_PUBLIC_KEY': JSON.stringify(process.env.STRIPE_PUBLIC_KEY || '')
    },
    plugins: [copyHtmlPlugin],
}).then(() => {
    console.log('⚡ Production build complete! Code is minified and ready.');
}).catch(() => process.exit(1));