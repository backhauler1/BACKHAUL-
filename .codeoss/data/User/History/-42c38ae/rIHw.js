const express = require('express');
const pool = require('./db');
const { protect } = require('./middleware/auth');
const PDFDocument = require('pdfkit');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const router = express.Router();

/**
 * GET /api/orders/history
 * Fetches the order history for the currently authenticated user.
 */
router.get('/history', protect, async (req, res) => {
    const userId = req.user.id;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10; // Default to 10 items per page
    const offset = (page - 1) * limit;

    try {
        // Use a single client for both queries to ensure data consistency
        const client = await pool.connect();
        try {
            // Query 1: Get the total count of orders for the user
            const totalItemsQuery = await client.query(
                `SELECT COUNT(*) FROM orders WHERE user_id = $1`,
                [userId]
            );
            const totalItems = parseInt(totalItemsQuery.rows[0].count, 10);
            const totalPages = Math.ceil(totalItems / limit);

            // Query 2: Fetch the paginated list of orders
            const ordersQuery = await client.query(
                `SELECT 
                    id, 
                    amount, 
                    currency, 
                    status, 
                    created_at 
                 FROM orders 
                 WHERE user_id = $1 
                 ORDER BY created_at DESC
                 LIMIT $2 OFFSET $3`,
                [userId, limit, offset]
            );

            res.status(200).json({
                message: 'Successfully retrieved order history.',
                data: ordersQuery.rows,
                pagination: {
                    currentPage: page,
                    totalPages,
                    totalItems,
                }
            });
        } finally {
            // Release the client back to the pool
            client.release();
        }
    } catch (error) {
        console.error('Get Order History Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching order history.' });
    }
});

/**
 * GET /api/orders/invoice/:orderId/pdf
 * Generates and streams a PDF invoice for a specific order.
 */
router.get('/invoice/:orderId/pdf', protect, async (req, res) => {
    const { orderId } = req.params;
    const userId = req.user.id;

    try {
        // Fetch the specific order, ensuring it belongs to the logged-in user.
        // We join with the users table to get customer details for the invoice.
        const orderQuery = await pool.query(
            `SELECT o.id, o.amount, o.currency, o.status, o.created_at, u.name as user_name, u.email as user_email
             FROM orders o
             JOIN users u ON o.user_id = u.id
             WHERE o.id = $1 AND o.user_id = $2`,
            [orderId, userId]
        );

        const order = orderQuery.rows[0];

        if (!order) {
            return res.status(404).json({ message: 'Invoice not found or you do not have permission to view it.' });
        }

        // Fetch line items for the order. This assumes you have an 'order_items' table.
        const itemsQuery = await pool.query(
            `SELECT description, quantity, unit_price, total_price 
             FROM order_items 
             WHERE order_id = $1 
             ORDER BY id ASC`,
            [orderId]
        );
        const items = itemsQuery.rows;
        // If there are no items, we can still generate an invoice with just the total.

        // --- PDF Generation using pdfkit ---
        const doc = new PDFDocument({ size: 'A4', margin: 50 });

        // Set response headers to trigger a download in the browser
        const filename = `invoice-${order.id.toString().padStart(6, '0')}.pdf`;
        res.setHeader('Content-disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-type', 'application/pdf');

        // Pipe the PDF document to the response stream
        doc.pipe(res);

        // --- Add content to the PDF ---
        doc.fontSize(20).text('Invoice', { align: 'center' });
        doc.moveDown(2);

        doc.fontSize(12);
        doc.text('Your Company Name', { continued: true });
        doc.text(`Invoice #: ${order.id.toString().padStart(6, '0')}`, { align: 'right' });
        doc.text('123 Your Street', { continued: true });
        doc.text(`Date: ${new Date(order.created_at).toLocaleDateString()}`, { align: 'right' });
        doc.text('Your City, ST 12345', { continued: true });
        doc.text(`Status: ${order.status}`, { align: 'right' });
        doc.moveDown(2);

        doc.text('Bill To:');
        doc.text(order.user_name);
        doc.text(order.user_email);
        doc.moveDown(2);

        // --- Invoice Table ---
        const invoiceTableTop = doc.y;
        doc.font('Helvetica-Bold');
        doc.fontSize(10)
            .text('Description', 50, invoiceTableTop)
            .text('Qty', 280, invoiceTableTop, { width: 90, align: 'right' })
            .text('Unit Price', 370, invoiceTableTop, { width: 90, align: 'right' })
            .text('Total', 0, invoiceTableTop, { align: 'right' });

        doc.moveTo(50, invoiceTableTop + 15).lineTo(550, invoiceTableTop + 15).stroke();

        doc.font('Helvetica');
        let currentY = invoiceTableTop + 25;

        if (items.length > 0) {
            items.forEach(item => {
                const unitPrice = (item.unit_price / 100).toFixed(2);
                const totalPrice = (item.total_price / 100).toFixed(2);

                doc.fontSize(10)
                    .text(item.description, 50, currentY)
                    .text(item.quantity.toString(), 280, currentY, { width: 90, align: 'right' })
                    .text(`$${unitPrice}`, 370, currentY, { width: 90, align: 'right' })
                    .text(`$${totalPrice}`, 0, currentY, { align: 'right' });
                currentY += 20;
            });
        } else {
            // Fallback for orders without line items
            doc.fontSize(10).text(`Payment for Order #${order.id}`, 50, currentY);
            currentY += 20;
        }

        doc.moveTo(50, currentY).lineTo(550, currentY).stroke();

        const totalAmount = (order.amount / 100).toFixed(2);
        doc.font('Helvetica-Bold').fontSize(12).text('Grand Total:', 370, currentY + 10, { width: 90, align: 'right' }).text(`$${totalAmount}`, 0, currentY + 10, { align: 'right' });

        // Finalize the PDF and end the stream
        doc.end();
    } catch (error) {
        console.error('PDF Generation Error:', error);
        res.status(500).json({ message: 'Internal server error while generating PDF.' });
    }
});

/**
 * POST /api/orders/:orderId/cancel
 * Cancels an order and issues a full refund via Stripe.
 */
router.post('/:orderId/cancel', protect, async (req, res) => {
    const { orderId } = req.params;
    const userId = req.user.id;

    try {
        // 1. Fetch the order to ensure it exists, belongs to the user, and is successful
        const orderQuery = await pool.query(
            `SELECT id, stripe_payment_intent_id, status FROM orders WHERE id = $1 AND user_id = $2`,
            [orderId, userId]
        );
        const order = orderQuery.rows[0];

        if (!order) {
            return res.status(404).json({ message: 'Order not found or unauthorized.' });
        }

        if (order.status !== 'succeeded') {
            return res.status(400).json({ message: `Order cannot be refunded because its status is '${order.status}'.` });
        }

        // 2. Issue the refund through Stripe using the Payment Intent ID
        await stripe.refunds.create({
            payment_intent: order.stripe_payment_intent_id,
        });

        // 3. Update the order status in the database to reflect the refund
        await pool.query(`UPDATE orders SET status = 'refunded' WHERE id = $1`, [orderId]);

        res.status(200).json({ message: 'Order successfully cancelled and refunded.' });
    } catch (error) {
        console.error('Cancel Order Error:', error);
        res.status(500).json({ message: 'Internal server error while cancelling the order.' });
    }
});

module.exports = router;