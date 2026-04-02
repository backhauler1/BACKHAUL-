const esbuild = require('esbuild');

async function watch() {
    // 1. Create a context for your build
    const ctx = await esbuild.context({
        entryPoints: ['app.js', 'style.css'], // Add your entry points here
        bundle: true,
        outdir: 'dist',
        sourcemap: true, // Helpful for debugging in development
        // define: { 'process.env.APP_VERSION': '"dev"' }, // Optional dev versioning
    });

    // 2. Tell the context to watch for file changes
    await ctx.watch();
    console.log('👀 Watching for file changes...');
    
    // Note: The process will intentionally not exit so it can keep watching.
}

watch().catch((err) => {
    console.error(err);
    process.exit(1);
});