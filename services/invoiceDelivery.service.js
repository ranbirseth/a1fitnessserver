class InvoiceDeliveryService {
  constructor() {
    this.providers = {
      email: { enabled: false, configured: false, name: "Email (SMTP)" },
      whatsapp: { enabled: false, configured: false, name: "WhatsApp" },
      sms: { enabled: false, configured: false, name: "SMS" }
    };
  }

  isFeatureEnabled(feature) {
    const provider = this.providers[feature];
    return provider && provider.enabled && provider.configured;
  }

  async canSendInvoice(/* gymId */) {
    return {
      allowed: false,
      reason: "subscription_required",
      message: "Invoice sending is a premium feature. A subscription is required to enable Email, WhatsApp or SMS delivery.",
      availableProviders: Object.entries(this.providers).map(([key, val]) => ({
        key,
        name: val.name,
        configured: val.configured,
        enabled: val.enabled
      }))
    };
  }

  async configureProvider(providerKey, config) {
    if (!this.providers[providerKey]) {
      throw new Error(`Unknown delivery provider: ${providerKey}`);
    }
    this.providers[providerKey] = { ...this.providers[providerKey], ...config };
    return { success: true, provider: providerKey };
  }

  async sendInvoice(/* invoiceData, channels = ["email"] */) {
    const permission = await this.canSendInvoice();
    if (!permission.allowed) {
      throw Object.assign(new Error(permission.message), {
        statusCode: 402,
        code: "SUBSCRIPTION_REQUIRED",
        details: permission
      });
    }
    return { success: false, message: "Send invoice is not available until external providers are configured." };
  }
}

module.exports = new InvoiceDeliveryService();
