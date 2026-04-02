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
        background: '#000000',       // Banner background color
        text: '#cbb26a',             // Main text color
        link: '#cbb26a',             // "Learn more" link color
        acceptBg: '#cbb26a',         // Accept button background color
        acceptText: '#000000',       // Accept button text color
        declineBorder: '#cbb26a',    // Decline button border color
        declineText: '#cbb26a'       // Decline button text color
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
            <a href="#" id="learn-more-link" style="color: ${theme.link}; text-decoration: underline;">Learn more</a>.
        </div>
        <div style="display: flex; gap: 10px; white-space: nowrap;">
            <button id="decline-cookies-btn" style="padding: 8px 15px; border: 1px solid ${theme.declineBorder}; background: transparent; color: ${theme.declineText}; border-radius: 4px; cursor: pointer; font-weight: bold;">Decline</button>
            <button id="accept-cookies-btn" style="padding: 8px 15px; border: none; background: ${theme.acceptBg}; color: ${theme.acceptText}; border-radius: 4px; cursor: pointer; font-weight: bold;">Accept</button>
        </div>
    `;

    document.body.appendChild(banner);

    document.getElementById('learn-more-link').addEventListener('click', (e) => {
        e.preventDefault();
        showPrivacyModal();
    });

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

function showPrivacyModal() {
    if (document.getElementById('privacy-modal-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'privacy-modal-overlay';
    overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 10001;';
    
    const modal = document.createElement('div');
    modal.style.cssText = 'background: #000000; border: 1px solid #cbb26a; width: 90%; max-width: 800px; height: 80vh; max-height: 600px; border-radius: 8px; box-shadow: 0 10px 25px rgba(0,0,0,0.8); display: flex; flex-direction: column; overflow: hidden; position: relative; font-family: sans-serif;';
    
    const header = document.createElement('div');
    header.style.cssText = 'padding: 15px 20px; border-bottom: 1px solid #cbb26a; display: flex; justify-content: space-between; align-items: center; background: #000000; color: #cbb26a;';
    header.innerHTML = '<h3 style="margin: 0; font-size: 1.2em;">Privacy Policy</h3><button id="close-privacy-modal" style="background: none; border: none; font-size: 1.5em; cursor: pointer; color: #cbb26a; line-height: 1; padding: 0;">&times;</button>';
    
    const iframe = document.createElement('iframe');
    iframe.src = '/privacy.html';
    iframe.style.cssText = 'flex: 1; width: 100%; border: none; background: #000000;';
    
    const footer = document.createElement('div');
    footer.style.cssText = 'padding: 15px 20px; border-top: 1px solid #cbb26a; display: flex; justify-content: flex-end; background: #000000;';
    
    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Accept & Close';
    acceptBtn.style.cssText = 'padding: 8px 15px; border: none; background: #cbb26a; color: #000000; border-radius: 4px; cursor: pointer; font-weight: bold;';
    
    acceptBtn.addEventListener('click', () => {
        localStorage.setItem('ad_consent', 'accepted');
        overlay.remove(); // Close the modal
        const banner = document.getElementById('cookie-consent-banner');
        if (banner) banner.remove(); // Close the main banner if it's still open
        loadAdScripts(true);
    });

    footer.appendChild(acceptBtn);

    modal.appendChild(header);
    modal.appendChild(iframe);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    document.getElementById('close-privacy-modal').addEventListener('click', () => overlay.remove());
    
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
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
    ccpaLink.style.color = '#000000';
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