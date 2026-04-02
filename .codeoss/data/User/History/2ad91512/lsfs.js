import { apiFetch } from './apiUtil.js';

/**
 * Fetches and renders reviews for a specific user.
 * @param {string} userId - The ID of the user whose profile is being viewed.
 * @param {string} containerId - The ID of the DOM element to render the reviews into.
 */
export async function loadUserReviews(userId, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<p style="color: #666;">Loading reviews...</p>';

    try {
        const response = await apiFetch(`/api/users/${userId}/reviews`);
        const reviews = response.data;
        const summary = response.summary;

        container.innerHTML = ''; // Clear loading text

        // 1. Render the Average Rating Summary
        if (summary && summary.totalRatings > 0) {
            const summaryDiv = document.createElement('div');
            summaryDiv.style.marginBottom = '20px';
            summaryDiv.style.paddingBottom = '15px';
            summaryDiv.style.borderBottom = '2px solid #eee';

            const roundedRating = Math.round(summary.averageRating);
            const avgStars = '★'.repeat(roundedRating) + '☆'.repeat(5 - roundedRating);
            
            summaryDiv.innerHTML = `
                <h4 style="margin: 0 0 5px 0; color: #333;">Average Rating</h4>
                <div style="font-size: 1.5em; color: #f5b301;">
                    ${avgStars} <span style="color: #333; font-size: 0.8em; font-weight: bold;">${summary.averageRating.toFixed(1)} / 5</span>
                </div>
                <p style="margin: 5px 0 0 0; color: #666; font-size: 0.9em;">Based on ${summary.totalRatings} total rating${summary.totalRatings === 1 ? '' : 's'}</p>
            `;
            container.appendChild(summaryDiv);
        }

        // 2. Render the Written Reviews List
        if (!reviews || reviews.length === 0) {
            const noReviews = document.createElement('p');
            noReviews.style.color = '#666';
            noReviews.style.fontStyle = 'italic';
            noReviews.textContent = 'No written reviews yet.';
            container.appendChild(noReviews);
            return;
        }

        const list = document.createElement('ul');
        list.style.listStyleType = 'none';
        list.style.padding = '0';

        reviews.forEach(review => {
            const li = document.createElement('li');
            li.style.borderBottom = '1px solid #eee';
            li.style.padding = '10px 0';
            li.style.marginBottom = '10px';
            
            const stars = '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
            const date = new Date(review.created_at).toLocaleDateString();

            li.innerHTML = `
                <div style="display: flex; gap: 10px; align-items: baseline;">
                    <span style="color: #f5b301; font-size: 1.1em;">${stars}</span>
                    <strong>${review.reviewer_name}</strong>
                    <span style="color: #888; font-size: 0.85em;">${date}</span>
                </div>
                <p style="margin: 5px 0 0 0; color: #333; line-height: 1.4;">${review.review}</p>
            `;
            list.appendChild(li);
        });

        container.appendChild(list);
    } catch (error) {
        container.innerHTML = '<p style="color: red;">Failed to load reviews.</p>';
        console.error('Error loading reviews:', error);
    }
}