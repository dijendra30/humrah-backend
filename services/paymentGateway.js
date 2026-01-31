// services/paymentGateway.js - Payment Gateway Service (Razorpay/Cashfree)
const axios = require('axios');

/**
 * Payment Gateway Service
 * This is a wrapper around your chosen payment gateway (Razorpay, Cashfree, etc.)
 * Update the implementation based on your actual payment provider
 */

class PaymentGatewayService {
  constructor() {
    this.apiKey = process.env.PAYMENT_GATEWAY_API_KEY;
    this.apiSecret = process.env.PAYMENT_GATEWAY_API_SECRET;
    this.baseURL = process.env.PAYMENT_GATEWAY_URL || 'https://api.razorpay.com/v1';
  }

  /**
   * Verify UPI ID exists and get account holder name
   */
  async verifyUPI(upiId) {
    try {
      // Example using Razorpay Fund Account Validation API
      const response = await axios.post(
        `${this.baseURL}/fund_accounts/validations`,
        {
          fund_account: {
            account_type: 'vpa',
            vpa: {
              address: upiId
            }
          },
          amount: 100, // Re 1 for validation
          currency: 'INR',
          notes: {
            purpose: 'UPI Verification'
          }
        },
        {
          auth: {
            username: this.apiKey,
            password: this.apiSecret
          },
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.status === 'completed' && response.data.results.account_status === 'active') {
        return {
          success: true,
          name: response.data.results.registered_name || 'Unknown',
          upiId: upiId,
          provider: response.data.results.vpa_details?.provider || 'Unknown'
        };
      } else {
        return {
          success: false,
          error: 'UPI ID not active or invalid'
        };
      }
    } catch (error) {
      console.error('UPI verification error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.description || 'Verification failed'
      };
    }
  }

  /**
   * Transfer money to UPI ID
   */
  async transferToUPI({ upiId, amount, referenceId }) {
    try {
      // Example using Razorpay Payouts API
      const response = await axios.post(
        `${this.baseURL}/payouts`,
        {
          account_number: process.env.RAZORPAY_ACCOUNT_NUMBER, // Your Razorpay account
          fund_account: {
            account_type: 'vpa',
            vpa: {
              address: upiId
            }
          },
          amount: amount * 100, // Convert to paise
          currency: 'INR',
          mode: 'UPI',
          purpose: 'payout',
          queue_if_low_balance: false,
          reference_id: referenceId,
          narration: 'Humrah Payout'
        },
        {
          auth: {
            username: this.apiKey,
            password: this.apiSecret
          },
          headers: {
            'Content-Type': 'application/json',
            'X-Payout-Idempotency': referenceId // Prevent duplicate payouts
          }
        }
      );

      if (response.data.status === 'processed' || response.data.status === 'processing') {
        return {
          success: true,
          transactionId: response.data.id,
          utr: response.data.utr, // Unique Transaction Reference
          status: response.data.status,
          processedAt: response.data.processed_at
        };
      } else {
        return {
          success: false,
          error: response.data.status_details?.description || 'Transfer failed'
        };
      }
    } catch (error) {
      console.error('UPI transfer error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.description || 'Transfer failed',
        code: error.response?.data?.error?.code
      };
    }
  }

  /**
   * Get payout status
   */
  async getPayoutStatus(payoutId) {
    try {
      const response = await axios.get(
        `${this.baseURL}/payouts/${payoutId}`,
        {
          auth: {
            username: this.apiKey,
            password: this.apiSecret
          }
        }
      );

      return {
        success: true,
        status: response.data.status,
        utr: response.data.utr,
        failureReason: response.data.status_details?.description || null
      };
    } catch (error) {
      console.error('Get payout status error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'Failed to get status'
      };
    }
  }

  /**
   * Verify webhook signature (for payout status updates)
   */
  verifyWebhookSignature(payload, signature) {
    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', process.env.PAYMENT_GATEWAY_WEBHOOK_SECRET)
      .update(JSON.stringify(payload))
      .digest('hex');

    return signature === expectedSignature;
  }

  /**
   * Get account balance
   */
  async getBalance() {
    try {
      const response = await axios.get(
        `${this.baseURL}/balance`,
        {
          auth: {
            username: this.apiKey,
            password: this.apiSecret
          }
        }
      );

      return {
        success: true,
        balance: response.data.balance / 100, // Convert from paise
        currency: response.data.currency
      };
    } catch (error) {
      console.error('Get balance error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'Failed to get balance'
      };
    }
  }
}

// =============================================
// ALTERNATIVE: Cashfree Implementation
// =============================================

class CashfreePaymentService {
  constructor() {
    this.clientId = process.env.CASHFREE_CLIENT_ID;
    this.clientSecret = process.env.CASHFREE_CLIENT_SECRET;
    this.baseURL = process.env.CASHFREE_ENV === 'production'
      ? 'https://payout-api.cashfree.com'
      : 'https://payout-gamma.cashfree.com';
  }

  async getAuthToken() {
    try {
      const response = await axios.post(
        `${this.baseURL}/payout/v1/authorize`,
        {
          clientId: this.clientId,
          clientSecret: this.clientSecret
        }
      );

      return response.data.data.token;
    } catch (error) {
      console.error('Cashfree auth error:', error);
      throw new Error('Authentication failed');
    }
  }

  async verifyUPI(upiId) {
    try {
      const token = await this.getAuthToken();

      const response = await axios.post(
        `${this.baseURL}/payout/v1/validation/bankDetails`,
        {
          vpa: upiId
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.status === 'SUCCESS') {
        return {
          success: true,
          name: response.data.data.nameAtBank,
          upiId: upiId
        };
      } else {
        return {
          success: false,
          error: 'UPI verification failed'
        };
      }
    } catch (error) {
      console.error('Cashfree UPI verification error:', error);
      return {
        success: false,
        error: error.response?.data?.message || 'Verification failed'
      };
    }
  }

  async transferToUPI({ upiId, amount, referenceId }) {
    try {
      const token = await this.getAuthToken();

      const response = await axios.post(
        `${this.baseURL}/payout/v1/requestTransfer`,
        {
          beneId: `humrah_${referenceId}`,
          amount: amount.toString(),
          transferId: referenceId,
          transferMode: 'upi',
          remarks: 'Humrah Payout'
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.status === 'SUCCESS') {
        return {
          success: true,
          transactionId: response.data.data.referenceId,
          utr: response.data.data.utr,
          status: 'processed'
        };
      } else {
        return {
          success: false,
          error: response.data.message || 'Transfer failed'
        };
      }
    } catch (error) {
      console.error('Cashfree transfer error:', error);
      return {
        success: false,
        error: error.response?.data?.message || 'Transfer failed'
      };
    }
  }
}

// =============================================
// EXPORT
// =============================================

// Choose your payment gateway
const USE_CASHFREE = process.env.PAYMENT_PROVIDER === 'cashfree';

module.exports = USE_CASHFREE 
  ? new CashfreePaymentService()
  : new PaymentGatewayService();
