/**
 * Cookie Consent & Ad Compliance Manager
 * Handles GDPR cookie banners, CCPA "Do Not Sell" links, and Ad Network configuration.
 */

export function initCookieConsent() {
    // Check if the user has already answered the prompt
    const consent = localStorage.getItem('ad_consent');

    if (!consent) {
        showCookieBanner();
    } else if (consent === 'accepted') {
        loadAdScripts(true);
    } else {
        loadAdScripts(false);
    }

    setupCCPALink();
}

function showCookieBanner() {
    // --- CUSTOMIZE BANNER COLORS HERE ---
    const theme = {
        background: '#f8f9fa',       // Banner background color
        text: '#333333',             // Main text color
        link: '#007bff',             // "Learn more" link color
        acceptBg: '#007bff',         // Accept button background color
        acceptText: '#ffffff',       // Accept button text color
        declineBorder: '#6c757d',    // Decline button border color
        declineText: '#6c757d'       // Decline button text color
    };

    const banner = document.createElement('div');
    banner.id = 'cookie-consent-banner';
    banner.style.cssText = `
        position: fixed;
        bottom: 0;
        left: 0;
        width: 100%;
        background-color: ${theme.background};
        color: ${theme.text};
        padding: 15px 20px;
        box-shadow: 0 -5px 15px rgba(0,0,0,0.1);
        display: flex;
        justify-content: space-between;
        align-items: center;
        z-index: 10000;
        font-family: sans-serif;
        box-sizing: border-box;
        flex-wrap: wrap;
        gap: 15px;
    `;

    banner.innerHTML = `
        <div style="flex: 1; min-width: 250px; font-size: 0.9em; line-height: 1.5;">
            We use cookies and third-party tracking to serve personalized ads and improve your experience. 
            By clicking "Accept", you consent to our use of these technologies. 
            <a href="/privacy.html" target="_blank" style="color: ${theme.link}; text-decoration: underline;">Learn more</a>.
        </div>
        <div style="display: flex; gap: 10px; white-space: nowrap;">
            <button id="decline-cookies-btn" style="padding: 8px 15px; border: 1px solid ${theme.declineBorder}; background: transparent; color: ${theme.declineText}; border-radius: 4px; cursor: pointer; font-weight: bold;">Decline</button>
            <button id="accept-cookies-btn" style="padding: 8px 15px; border: none; background: ${theme.acceptBg}; color: ${theme.acceptText}; border-radius: 4px; cursor: pointer; font-weight: bold;">Accept</button>
        </div>
    `;

    document.body.appendChild(banner);

    document.getElementById('accept-cookies-btn').addEventListener('click', () => {
        localStorage.setItem('ad_consent', 'accepted');
        banner.remove();
        loadAdScripts(true);
    });

    document.getElementById('decline-cookies-btn').addEventListener('click', () => {
        localStorage.setItem('ad_consent', 'declined');
        banner.remove();
        loadAdScripts(false); // Load ads, but strictly non-personalized
    });
}

function loadAdScripts(isPersonalized) {
    // Example Configuration for Google AdSense / Google Publisher Tags
    window.adsbygoogle = window.adsbygoogle || [];
    
    if (!isPersonalized) {
        // Forces Google to serve non-personalized ads (no tracking cookies)
        window.adsbygoogle.requestNonPersonalizedAds = 1;
        console.log('Ad Consent: Declined. Serving Non-Personalized Ads (NPA).');
    } else {
        console.log('Ad Consent: Accepted. Serving Personalized Ads.');
    }

    // Dynamically load the Google AdSense script
    const script = document.createElement('script');
    // Replace ca-pub-XXXXXXXXXXXXXXXX with your actual Publisher ID below
    script.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-XXXXXXXXXXXXXXXX";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.dataset.adClient = "ca-pub-XXXXXXXXXXXXXXXX"; 
    document.head.appendChild(script);
}

function setupCCPALink() {
    // Look for a footer to attach the link to, fallback to the body
    const footer = document.querySelector('footer') || document.body;
    
    // Prevent injecting duplicates
    if (document.getElementById('ccpa-opt-out')) return;

    const ccpaContainer = document.createElement('div');
    ccpaContainer.style.cssText = 'text-align: center; padding: 15px; font-size: 0.85em; width: 100%;';
    
    const ccpaLink = document.createElement('a');
    ccpaLink.id = 'ccpa-opt-out';
    ccpaLink.href = '#';
    ccpaLink.textContent = 'Do Not Sell or Share My Personal Information';
    ccpaLink.style.color = '#6c757d';
    ccpaLink.style.textDecoration = 'underline';

    ccpaLink.addEventListener('click', (e) => {
        e.preventDefault();
        
        // Opt the user out of personalized ads
        localStorage.setItem('ad_consent', 'declined');
        
        alert('Your preference has been saved. We will no longer share your tracking data for personalized advertising.');
        
        // Reload the page so the NPA settings take effect immediately
        window.location.reload();
    });

    ccpaContainer.appendChild(ccpaLink);
    footer.appendChild(ccpaContainer);
}