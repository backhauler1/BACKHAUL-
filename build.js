const esbuild = require('esbuild');

const isProd = process.env.NODE_ENV === 'production';

// Bundle the frontend application
esbuild.build({
    entryPoints: [
        // Adjust these to match your actual main frontend entry files
        'public/js/main.js', 
        'public/css/style.css'
    ],
    bundle: true,
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