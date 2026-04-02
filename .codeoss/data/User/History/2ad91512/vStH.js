import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

let currentPage = 1;
let isFetching = false;

/**
 * Fetches and renders reviews for a specific user.
 * @param {string} userId - The ID of the user whose profile is being viewed.
 * @param {string} containerId - The ID of the DOM element to render the reviews into.
 */
export async function loadUserReviews(userId, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<p style="color: #666;">Loading reviews...</p>';
    currentPage = 1;

    try {
        const response = await apiFetch(`/api/users/${userId}/reviews?page=${currentPage}&limit=5`);
        const reviews = response.data;
        const summary = response.summary;
        const pagination = response.pagination;

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
        container.appendChild(list);

        appendReviewsToList(reviews, list, userId, containerId);

        // 3. Render the "Load More" Button if there are more pages
        if (pagination && pagination.currentPage < pagination.totalPages) {
            const loadMoreBtn = document.createElement('button');
            loadMoreBtn.textContent = 'Load More';
            loadMoreBtn.style.width = '100%';
            loadMoreBtn.style.padding = '8px';
            loadMoreBtn.style.marginTop = '15px';
            loadMoreBtn.style.backgroundColor = '#f1f1f1';
            loadMoreBtn.style.border = '1px solid #ccc';
            loadMoreBtn.style.borderRadius = '4px';
            loadMoreBtn.style.cursor = 'pointer';
            
            loadMoreBtn.addEventListener('click', async () => {
                if (isFetching) return;
                isFetching = true;
                currentPage++;
                
                loadMoreBtn.textContent = 'Loading...';
                loadMoreBtn.disabled = true;

                try {
                    const moreResponse = await apiFetch(`/api/users/${userId}/reviews?page=${currentPage}&limit=5`);
                    appendReviewsToList(moreResponse.data, list, userId, containerId);

                    if (moreResponse.pagination.currentPage >= moreResponse.pagination.totalPages) {
                        loadMoreBtn.style.display = 'none';
                    }
                } catch (err) {
                    console.error('Failed to load more reviews:', err);
                } finally {
                    isFetching = false;
                    loadMoreBtn.textContent = 'Load More';
                    loadMoreBtn.disabled = false;
                }
            });

            container.appendChild(loadMoreBtn);
        }
    } catch (error) {
        container.innerHTML = '<p style="color: red;">Failed to load reviews.</p>';
        console.error('Error loading reviews:', error);
    }
}

function appendReviewsToList(reviews, listElement, targetUserId, containerId) {
    const currentUserId = document.body.dataset.userId;

    reviews.forEach(review => {
        const li = document.createElement('li');
        li.style.borderBottom = '1px solid #eee';
        li.style.padding = '10px 0';
        li.style.marginBottom = '10px';
        
        renderViewMode(li, review, currentUserId, targetUserId, containerId);
        listElement.appendChild(li);
    });
}

function renderViewMode(li, review, currentUserId, targetUserId, containerId) {
    const stars = '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
    const date = new Date(review.created_at).toLocaleDateString();

    let actionButtons = '';
    if (currentUserId && String(review.rater_id) === String(currentUserId)) {
        actionButtons = `
            <div style="margin-top: 10px;">
                <button class="edit-review-btn" style="background: #007bff; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 0.8em; margin-right: 5px;">Edit</button>
                <button class="delete-review-btn" style="background: #dc3545; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 0.8em;">Delete</button>
            </div>
        `;
    }

    li.innerHTML = `
        <div style="display: flex; gap: 10px; align-items: baseline;">
            <span style="color: #f5b301; font-size: 1.1em;">${stars}</span>
            <strong>${review.reviewer_name}</strong>
            <span style="color: #888; font-size: 0.85em;">${date}</span>
        </div>
        <p style="margin: 5px 0 0 0; color: #333; line-height: 1.4;">${review.review}</p>
        ${actionButtons}
    `;

    const editBtn = li.querySelector('.edit-review-btn');
    const deleteBtn = li.querySelector('.delete-review-btn');

    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            if (!confirm('Are you sure you want to delete this review?')) return;
            try {
                await apiFetch(`/api/loads/${review.load_id}/rate`, { method: 'DELETE' });
                showNotification('Review deleted successfully.', 'success');
                loadUserReviews(targetUserId, containerId); // Reload the whole section to refresh average
            } catch (error) {
                showNotification(`Failed to delete review: ${error.message}`, 'error');
            }
        });
    }

    if (editBtn) {
        editBtn.addEventListener('click', () => {
            renderEditMode(li, review, currentUserId, targetUserId, containerId);
        });
    }
}

function renderEditMode(li, review, currentUserId, targetUserId, containerId) {
    li.innerHTML = `
        <form class="inline-edit-form" style="display: flex; flex-direction: column; gap: 10px; background: #f9f9f9; padding: 10px; border-radius: 4px;">
            <div style="display: flex; align-items: center; gap: 10px;">
                <label><strong>Rating:</strong></label>
                <select name="rating" style="padding: 4px;">
                    ${[1,2,3,4,5].map(num => `<option value="${num}" ${num === review.rating ? 'selected' : ''}>${num} Star${num>1?'s':''}</option>`).join('')}
                </select>
            </div>
            <textarea name="review" rows="3" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; resize: vertical;">${review.review}</textarea>
            <div>
                <button type="submit" style="background: #28a745; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 0.85em;">Save</button>
                <button type="button" class="cancel-edit-btn" style="background: #6c757d; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 0.85em; margin-left: 5px;">Cancel</button>
            </div>
        </form>
    `;

    li.querySelector('.cancel-edit-btn').addEventListener('click', () => {
        renderViewMode(li, review, currentUserId, targetUserId, containerId);
    });

    li.querySelector('.inline-edit-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const newRating = parseInt(e.target.rating.value, 10);
        const newReview = e.target.review.value.trim();

        try {
            await apiFetch(`/api/loads/${review.load_id}/rate`, {
                method: 'PUT',
                body: { rating: newRating, review: newReview }
            });
            showNotification('Review updated successfully.', 'success');
            loadUserReviews(targetUserId, containerId); // Reload to get fresh data
        } catch (error) {
            showNotification(`Failed to update review: ${error.message}`, 'error');
        }
    });
}