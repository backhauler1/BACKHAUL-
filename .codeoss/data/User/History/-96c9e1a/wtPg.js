import i18next from 'i18next';

// Initialize i18next
i18next.init({
    // Automatically detect the browser's language, fallback to English
    lng: navigator.language || 'en', 
    fallbackLng: 'en',
    resources: {
        en: {
            translation: {
                orderHistory: {
                    loading: "Loading your orders...",
                    loadFailed: "Failed to load orders: {{message}}",
                    empty: "You have no past orders.",
                    headers: {
                        orderId: "Order ID",
                        date: "Date",
                        total: "Total",
                        status: "Status",
                        actions: "Actions"
                    },
                    downloadInvoice: "↓ PDF Invoice",
                    pagination: {
                        previous: "Previous",
                        next: "Next",
                        // i18next supports dynamic variable interpolation
                        pageIndicator: "Page {{current}} of {{total}}" 
                    }
                }
            }
        },
        es: {
            translation: {
                orderHistory: {
                    loading: "Cargando sus pedidos...",
                    loadFailed: "Error al cargar los pedidos: {{message}}",
                    empty: "No tiene pedidos anteriores.",
                    headers: {
                        orderId: "ID del pedido",
                        date: "Fecha",
                        total: "Total",
                        status: "Estado",
                        actions: "Acciones"
                    },
                    downloadInvoice: "↓ Factura PDF",
                    pagination: {
                        previous: "Anterior",
                        next: "Siguiente",
                        pageIndicator: "Página {{current}} de {{total}}"
                    }
                }
            }
        }
    }
});

// Export the translation function 't' to use across your app
export const t = i18next.t.bind(i18next);
export default i18next;