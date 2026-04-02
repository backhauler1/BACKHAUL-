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
const isProd = process.env.NODE_ENV === 'production';

const buildOptions = {
    entryPoints: ['app.js', 'style.css'], // Your entry points
// Bundle the frontend application
esbuild.build({
    entryPoints: [
        // Adjust these to match your actual main frontend entry files
        'public/js/main.js', 
        'public/css/style.css'
    ],
    bundle: true,
    outdir: 'dist',
    minify: true, // Compress the code for production
    sourcemap: false, // Turn off sourcemaps to save space and hide source code
    define: { 
        'process.env.NODE_ENV': '"production"', // Tell libraries (like React/Vue, if used) to optimize
        'process.env.STRIPE_PUBLIC_KEY': JSON.stringify(process.env.STRIPE_PUBLIC_KEY || ''),
        'process.env.PUBLIC_VAPID_KEY': JSON.stringify(process.env.PUBLIC_VAPID_KEY || ''),
        'process.env.MAPBOX_TOKEN': JSON.stringify(process.env.MAPBOX_TOKEN || '')
    },
    plugins: [copyAssetsPlugin],
};

const isWatchMode = process.argv.includes('--watch');

if (isWatchMode) {
    // Development/watch mode with a live-reloading dev server
    esbuild.context({
        ...buildOptions,
        sourcemap: true, // Enable sourcemaps for easier debugging
        minify: false,   // Disable minification for faster rebuilds
        define: { ...buildOptions.define, 'process.env.NODE_ENV': '"development"' },
        // Inject the Live Reload script into our JS bundle
        banner: {
            js: '(() => new EventSource("/esbuild").addEventListener("change", () => location.reload()))();',
        },
    }).then(async (ctx) => {
        await ctx.watch();
        const { host, port } = await ctx.serve({ servedir: 'dist', port: 8000 });
        console.log(`\n🚀 Development server running on http://${host}:${port}`);
        console.log('👀 Watching for changes...');
    }).catch(() => process.exit(1));
} else {
    // Production build
    esbuild.build(buildOptions).then(() => {
        console.log('⚡ Production build complete! Code is minified and ready.');
    }).catch(() => process.exit(1));
}
    minify: isProd,
    sourcemap: !isProd,
    target: ['es2020'],
    outdir: 'public/dist',
    treeShaking: true,
    logLevel: 'info',
}).catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
});