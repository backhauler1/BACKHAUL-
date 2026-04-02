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

async function watch() {
    // 1. Create a context for your build
    const ctx = await esbuild.context({
        entryPoints: ['app.js', 'style.css'], // Add your entry points here
        bundle: true,
        outdir: 'dist',
        sourcemap: true, // Helpful for debugging in development
        define: { 
            'process.env.NODE_ENV': '"development"',
            'process.env.STRIPE_PUBLIC_KEY': JSON.stringify(process.env.STRIPE_PUBLIC_KEY || '')
        },
        
        // Inject the Live Reload script directly into your bundle!
        banner: {
            js: '(() => new EventSource("http://localhost:8000/esbuild").addEventListener("change", () => location.reload()))();',
        },
        plugins: [copyHtmlPlugin],
    });

    // 2. Tell the context to watch for file changes
    await ctx.watch();

    // 3. Start the built-in development server for Live Reload
    const { host, port } = await ctx.serve({
        port: 8000, 
    });
    
    console.log(`👀 Watching for file changes...`);
    console.log(`🚀 esbuild live-reload server running on port ${port}`);
    
    // Note: The process will intentionally not exit so it can keep watching.
}

watch().catch((err) => {
    console.error(err);
    process.exit(1);
});