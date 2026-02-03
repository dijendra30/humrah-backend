// services/paymentGateway.js - UPDATED FIX
const axios = require('axios');

/**
 * Payment Gateway Service with Better Development Mode Detection
 */

class PaymentGatewayService {
  constructor() {
    this.apiKey = process.env.PAYMENT_GATEWAY_API_KEY;
    this.apiSecret = process.env.PAYMENT_GATEWAY_API_SECRET;
    this.accountNumber = process.env.RAZORPAY_ACCOUNT_NUMBER;
    this.baseURL = process.env.PAYMENT_GATEWAY_URL || 'https://api.razorpay.com/v1';
    
    // ✅ IMPROVED: More comprehensive development mode check
    this.isDevelopment = this.detectDevelopmentMode();
    
    if (this.isDevelopment) {
      console.log('');
      console.log('🧪 ========================================');
      console.log('🧪  PAYMENT GATEWAY: DEVELOPMENT MODE');
      console.log('🧪 ========================================');
      console.log('🧪  Using MOCK verification (no real API calls)');
      console.log('🧪  To use real Razorpay, set these env vars:');
      console.log('🧪    - PAYMENT_GATEWAY_API_KEY');
      console.log('🧪    - PAYMENT_GATEWAY_API_SECRET');
      console.log('🧪    - RAZORPAY_ACCOUNT_NUMBER');
      console.log('🧪 ========================================');
      console.log('');
    } else {
      console.log('✅ Payment Gateway: Production mode (Real Razorpay API)');
    }
  }

  /**
   * ✅ NEW: Better development mode detection
   */
  detectDevelopmentMode() {
    // Development mode if ANY of these conditions is true:
    const checks = {
      noApiKey: !this.apiKey,
      noApiSecret: !this.apiSecret,
      noAccountNumber: !this.accountNumber,
      envSetToDev: process.env.NODE_ENV === 'development',
      useMockPayments: process.env.USE_MOCK_PAYMENTS === 'true'
    };
    
    const isDevMode = Object.values(checks).some(check => check === true);
    
    if (isDevMode) {
      console.log('🔍 Development mode activated due to:');
      if (checks.noApiKey) console.log('   ❌ Missing PAYMENT_GATEWAY_API_KEY');
      if (checks.noApiSecret) console.log('   ❌ Missing PAYMENT_GATEWAY_API_SECRET');
      if (checks.noAccountNumber) console.log('   ❌ Missing RAZORPAY_ACCOUNT_NUMBER');
      if (checks.envSetToDev) console.log('   ✅ NODE_ENV=development');
      if (checks.useMockPayments) console.log('   ✅ USE_MOCK_PAYMENTS=true');
    }
    
    return isDevMode;
  }

  /**
   * Verify UPI ID exists and get account holder name
   */
  async verifyUPI(upiId) {
    console.log(`\n📝 Verifying UPI: ${upiId}`);
    
    // ✅ Use mock verification in development
    if (this.isDevelopment) {
      console.log('🧪 Using MOCK verification...');
      return this.mockVerifyUPI(upiId);
    }
    
    console.log('🔐 Using REAL Razorpay API...');
    
    try {
      // Razorpay Fund Account Validation API
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
          },
          timeout: 30000 // 30 second timeout
        }
      );

      if (response.data.status === 'completed' && response.data.results.account_status === 'active') {
        console.log('✅ UPI verification successful');
        return {
          success: true,
          name: response.data.results.registered_name || 'Account Holder',
          upiId: upiId,
          provider: response.data.results.vpa_details?.provider || 'Unknown'
        };
      } else {
        console.log('❌ UPI verification failed:', response.data.status);
        return {
          success: false,
          error: 'UPI ID not active or invalid'
        };
      }
    } catch (error) {
      console.error('❌ UPI verification error:', error.response?.data || error.message);
      
      // Better error handling
      const errorMessage = error.response?.data?.error?.description || 
                          error.message || 
                          'Verification failed';
      
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * ✅ Mock UPI verification for development/testing
   */
  mockVerifyUPI(upiId) {
    console.log(`   🎭 Simulating verification for: ${upiId}`);
    
    // Simulate network delay
    return new Promise((resolve) => {
      setTimeout(() => {
        // Basic validation
        const upiRegex = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
        if (!upiRegex.test(upiId)) {
          console.log('   ❌ Invalid UPI format');
          resolve({
            success: false,
            error: 'Invalid UPI ID format'
          });
          return;
        }
        
        // Extract name from UPI (before @)
        const namePart = upiId.split('@')[0];
        const provider = upiId.split('@')[1];
        const generatedName = this.generateMockName(namePart);
        
        console.log(`   ✅ Mock success! Name: ${generatedName}`);
        
        // Mock success response
        resolve({
          success: true,
          name: generatedName,
          upiId: upiId,
          provider: provider.toUpperCase()
        });
      }, 1500); // 1.5 second delay to simulate API call
    });
  }

  /**
   * Generate mock name from UPI ID
   */
  generateMockName(namePart) {
    // If it's a phone number, generate generic name
    if (/^\d+$/.test(namePart)) {
      return 'Account Holder';
    }
    
    // Convert to title case
    return namePart
      .split(/[._-]/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Transfer money to UPI ID
   */
  async transferToUPI({ upiId, amount, referenceId }) {
    console.log(`\n💸 Transferring ₹${amount} to ${upiId}`);
    
    // ✅ Use mock transfer in development
    if (this.isDevelopment) {
      console.log('🧪 Using MOCK transfer...');
      return this.mockTransferToUPI({ upiId, amount, referenceId });
    }
    
    console.log('🔐 Using REAL Razorpay API...');
    
    try {
      if (!this.accountNumber) {
        console.error('❌ RAZORPAY_ACCOUNT_NUMBER not set!');
        return {
          success: false,
          error: 'Payment gateway account not configured'
        };
      }
      
      const response = await axios.post(
        `${this.baseURL}/payouts`,
        {
          account_number: this.accountNumber,
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
            'X-Payout-Idempotency': referenceId
          },
          timeout: 30000
        }
      );

      if (response.data.status === 'processed' || response.data.status === 'processing') {
        console.log('✅ Transfer successful');
        return {
          success: true,
          transactionId: response.data.id,
          utr: response.data.utr,
          status: response.data.status,
          processedAt: response.data.processed_at
        };
      } else {
        console.log('❌ Transfer failed:', response.data.status);
        return {
          success: false,
          error: response.data.status_details?.description || 'Transfer failed'
        };
      }
    } catch (error) {
      console.error('❌ Transfer error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.description || 'Transfer failed',
        code: error.response?.data?.error?.code
      };
    }
  }

  /**
   * ✅ Mock UPI transfer for development
   */
  mockTransferToUPI({ upiId, amount, referenceId }) {
    console.log(`   🎭 Simulating transfer of ₹${amount}`);
    
    return new Promise((resolve) => {
      setTimeout(() => {
        const txnId = `mock_txn_${Date.now()}`;
        console.log(`   ✅ Mock transfer successful! TXN: ${txnId}`);
        
        resolve({
          success: true,
          transactionId: txnId,
          utr: `${Date.now()}`,
          status: 'processed',
          processedAt: new Date().toISOString()
        });
      }, 2000);
    });
  }

  /**
   * Get payout status
   */
  async getPayoutStatus(payoutId) {
    if (this.isDevelopment) {
      return {
        success: true,
        status: 'processed',
        utr: `${Date.now()}`,
        failureReason: null
      };
    }
    
    try {
      const response = await axios.get(
        `${this.baseURL}/payouts/${payoutId}`,
        {
          auth: {
            username: this.apiKey,
            password: this.apiSecret
          },
          timeout: 30000
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
   * Verify webhook signature
   */
  verifyWebhookSignature(payload, signature) {
    const crypto = require('crypto');
    const secret = process.env.PAYMENT_GATEWAY_WEBHOOK_SECRET;
    
    if (!secret) {
      console.warn('⚠️  Webhook secret not configured');
      return this.isDevelopment; // Return true in dev mode
    }
    
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('hex');

    return signature === expectedSignature;
  }

  /**
   * Get account balance
   */
  async getBalance() {
    if (this.isDevelopment) {
      return {
        success: true,
        balance: 100000.00, // Mock ₹1,00,000
        currency: 'INR'
      };
    }
    
    try {
      const response = await axios.get(
        `${this.baseURL}/balance`,
        {
          auth: {
            username: this.apiKey,
            password: this.apiSecret
          },
          timeout: 30000
        }
      );

      return {
        success: true,
        balance: response.data.balance / 100,
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
// EXPORT
// =============================================

module.exports = new PaymentGatewayService();
