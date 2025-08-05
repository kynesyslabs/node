# Telegram Identity Integration Guide
## For dApp and Bot Development Teams

This document outlines how the **dApp** and **Bot** teams should work together to implement seamless Telegram identity verification using the Demos node APIs.

## 🎯 **Goal: Seamless User Experience**

Instead of users manually copying/pasting messages, we want:
1. **User clicks "Link Telegram" on dApp** 
2. **Automatic coordination between dApp and bot**
3. **User signs transaction to complete** ✅

---

## 🏗️ **Architecture Overview**

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│     dApp        │    │      Bot        │    │      Node       │
│                 │    │                 │    │                 │
│ 1. Generate     │───▶│                 │    │                 │
│    Challenge    │    │                 │    │                 │
│                 │    │ 2. Listen for   │    │                 │
│ 3. Show Login   │    │    User Auth    │    │                 │
│    Button       │    │                 │    │                 │
│                 │    │ 4. Create       │───▶│ 5. Verify &     │
│                 │    │    Attestation  │    │    Create TX    │
│                 │    │                 │    │                 │
│ 7. Show TX      │◀───│ 6. Return TX    │◀───│                 │
│    to Sign      │    │    to dApp      │    │                 │
│                 │    │                 │    │                 │
│ 8. Submit       │─────────────────────────▶│ 9. Process      │
│    Signed TX    │    │                 │    │    Identity     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

---

## 🌐 **Option 1: Telegram Login Widget (Recommended)**

**Most Seamless Approach** - Use official Telegram Login Widget

### **dApp Implementation**:

```html
<!-- Add Telegram Login Widget -->
<script async src="https://telegram.org/js/telegram-widget.js?22" 
        data-telegram-login="YourBotUsername" 
        data-size="large" 
        data-auth-url="https://yourdapp.com/telegram-auth"
        data-request-access="write">
</script>
```

### **Flow**:
1. **User clicks Telegram Login Widget**
2. **Telegram authenticates user** (official OAuth-like flow)
3. **Telegram redirects to dApp** with auth data
4. **dApp receives**: `{ id, first_name, username, photo_url, auth_date, hash }`
5. **dApp generates challenge** via node API
6. **dApp signs challenge** with user's wallet
7. **dApp sends to bot** via Telegram Bot API (server-to-server)
8. **Bot creates attestation** and returns unsigned transaction
9. **dApp shows transaction** for user to sign
10. **User signs and submits** ✅

### **Advantages**:
- ✅ **Official Telegram integration**
- ✅ **No manual copy/paste**
- ✅ **Seamless UX**
- ✅ **Secure authentication**
- ✅ **Works on all devices**

---

## 🤖 **Option 2: Bot API Direct Integration**

**Alternative Approach** - Direct bot communication

### **Flow**:
1. **dApp generates unique session ID**
2. **dApp shows**: "Click here to verify with @DemosBot"
3. **Deep link**: `https://t.me/DemosBot?start=session_12345`
4. **Bot receives session ID** from deep link
5. **Bot calls dApp API**: "User started session_12345"
6. **dApp sends challenge** to bot for that session
7. **Bot gets user to sign** and creates attestation
8. **Bot returns unsigned transaction** to dApp
9. **dApp shows transaction** for user to sign

### **Advantages**:
- ✅ **No OAuth complexity**
- ✅ **Direct bot control**
- ✅ **Custom flow possible**

---

## 📋 **Recommended Implementation: Option 1**

### **dApp Team Tasks**:

#### **1. Frontend Integration**
```typescript
// telegram-auth.ts
interface TelegramAuthData {
  id: number
  first_name: string
  username?: string
  photo_url?: string
  auth_date: number
  hash: string
}

async function handleTelegramAuth(authData: TelegramAuthData) {
  // 1. Verify Telegram auth hash (security)
  if (!verifyTelegramAuth(authData)) {
    throw new Error('Invalid Telegram authentication')
  }
  
  // 2. Generate challenge via node
  const challengeResponse = await fetch('/api/tg-challenge', {
    method: 'POST',
    body: JSON.stringify({ demos_address: userWalletAddress })
  })
  const { challenge } = await challengeResponse.json()
  
  // 3. Sign challenge with user's wallet
  const signedChallenge = await wallet.signMessage(challenge)
  
  // 4. Send to bot via Bot API (server-to-server)
  const botResponse = await fetch('/api/telegram-bot-notify', {
    method: 'POST',
    body: JSON.stringify({
      telegramUser: authData,
      signedChallenge,
      sessionId: generateSessionId()
    })
  })
  
  // 5. Bot will process and return unsigned transaction
  const { unsignedTransaction } = await botResponse.json()
  
  // 6. Show transaction to user for signing
  showTransactionModal(unsignedTransaction)
}
```

#### **2. Bot Communication Endpoint**
```typescript
// pages/api/telegram-bot-notify.ts
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { telegramUser, signedChallenge, sessionId } = req.body
  
  // Send to bot via Telegram Bot API
  const botResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramUser.id,
      text: `Verification request received. Processing...`
    })
  })
  
  // Create attestation via bot
  const attestation = await createBotAttestation(telegramUser, signedChallenge)
  
  // Get unsigned transaction from node
  const nodeResponse = await fetch('https://node/api/tg-verify', {
    method: 'POST',
    body: JSON.stringify(attestation)
  })
  
  const { unsignedTransaction } = await nodeResponse.json()
  
  res.json({ unsignedTransaction })
}
```

### **Bot Team Tasks**:

#### **1. Bot Setup**
```python
# bot.py
import telegram
from telegram.ext import Application, CommandHandler, MessageHandler
import requests
import json

# Bot token from @BotFather
BOT_TOKEN = "your_bot_token"
NODE_URL = "https://node.demos.network"
GENESIS_PRIVATE_KEY = "your_genesis_private_key"
GENESIS_ADDRESS = "your_genesis_address"

bot = telegram.Bot(token=BOT_TOKEN)
```

#### **2. Verification Handler**
```python
async def handle_verification_request(telegram_user_id, telegram_username, signed_challenge):
    """
    Handle verification request from dApp
    """
    # Create attestation payload
    attestation = {
        'telegram_id': str(telegram_user_id),
        'username': telegram_username or '',
        'signed_challenge': signed_challenge,
        'timestamp': int(time.time())
    }
    
    # Sign attestation with bot's genesis private key
    attestation_json = json.dumps(attestation, sort_keys=True)
    bot_signature = sign_message(attestation_json, GENESIS_PRIVATE_KEY)
    
    # Submit to node
    payload = {
        **attestation,
        'bot_address': GENESIS_ADDRESS,
        'bot_signature': bot_signature
    }
    
    response = requests.post(f'{NODE_URL}/api/tg-verify', json=payload)
    
    if response.status_code == 200:
        data = response.json()
        return data.get('unsignedTransaction')
    else:
        raise Exception(f"Node verification failed: {response.text}")
```

#### **3. Webhook/API Integration**
```python
# For dApp to communicate with bot
@app.route('/webhook/verification', methods=['POST'])
def handle_dapp_verification():
    data = request.json
    telegram_user = data['telegramUser']
    signed_challenge = data['signedChallenge']
    
    try:
        unsigned_tx = await handle_verification_request(
            telegram_user['id'],
            telegram_user.get('username'),
            signed_challenge
        )
        
        return jsonify({
            'success': True,
            'unsignedTransaction': unsigned_tx
        })
    
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 400
```

---

## 🔐 **Security Considerations**

### **1. Telegram Auth Verification**
```typescript
// Verify Telegram authentication hash
function verifyTelegramAuth(authData: TelegramAuthData, botToken: string): boolean {
  const { hash, ...data } = authData
  
  // Create data string
  const dataCheckString = Object.keys(data)
    .sort()
    .map(key => `${key}=${data[key]}`)
    .join('\n')
  
  // Calculate expected hash
  const secretKey = crypto.createHash('sha256').update(botToken).digest()
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  
  return expectedHash === hash
}
```

### **2. Session Management**
- **Unique session IDs** for each verification attempt
- **Expiration**: 15 minutes max per session
- **Rate limiting**: Max 5 attempts per user per hour
- **CSRF protection**: Validate origin and referrer

### **3. Bot Security**
- **Genesis address validation**: Bot must own genesis private key
- **Signature verification**: All attestations cryptographically signed
- **IP allowlisting**: Only accept requests from known dApp servers
- **Webhook authentication**: Verify requests from dApp

---

## 🎨 **UX Flow Design**

### **Ideal User Experience**:

```
1. User on dApp → Clicks "Connect Telegram" button
2. Telegram Login Widget → Opens in popup/redirect
3. User authorizes → Returns to dApp automatically  
4. dApp shows → "Signing challenge with wallet..."
5. Wallet prompts → User signs challenge
6. dApp shows → "Verifying with Telegram bot..."
7. Process completes → "Sign transaction to finish linking"
8. User signs TX → "✅ Telegram linked successfully!"
```

### **Error Handling**:
- **Telegram auth fails** → Clear error message + retry button
- **Challenge signing fails** → Wallet-specific guidance
- **Bot verification fails** → Contact support info
- **Transaction fails** → Retry with gas adjustment

---

## 📱 **Mobile Considerations**

### **Deep Links**:
```typescript
// For mobile apps
const telegramDeepLink = `https://t.me/DemosBot?start=verify_${sessionId}`

// Fallback for web
const telegramWebLink = `https://web.telegram.org/k/#@DemosBot?start=verify_${sessionId}`
```

### **Responsive Design**:
- **Mobile-first** Telegram login widget
- **Touch-friendly** buttons and interfaces
- **Proper viewport** meta tags
- **App-like transitions** between steps

---

## 🧪 **Testing Strategy**

### **Integration Testing**:
1. **dApp generates challenge** → Verify API response
2. **Telegram auth simulation** → Mock auth data
3. **Bot attestation creation** → Test signature validity
4. **Node transaction creation** → Verify transaction structure
5. **End-to-end flow** → Complete user journey

### **Security Testing**:
- **Invalid signatures** → Should be rejected
- **Expired challenges** → Should fail gracefully
- **Replay attacks** → Should be prevented
- **Bot impersonation** → Should be blocked

---

## 🚀 **Deployment Coordination**

### **Sequence**:
1. **Node APIs** deployed and tested ✅ (Already done)
2. **Bot** deployed with webhook endpoints
3. **dApp** updated with Telegram integration
4. **Integration testing** across all components
5. **Production rollout** with monitoring

### **Configuration**:
```env
# dApp .env
TELEGRAM_BOT_USERNAME=DemosBot
TELEGRAM_BOT_WEBHOOK_URL=https://bot.demos.network/webhook
NODE_API_URL=https://node.demos.network

# Bot .env  
BOT_TOKEN=your_telegram_bot_token
GENESIS_PRIVATE_KEY=your_genesis_private_key
GENESIS_ADDRESS=your_genesis_address
WEBHOOK_SECRET=random_secret_for_dapp_communication
DAPP_ALLOWED_ORIGINS=https://app.demos.network,https://demos.network
```

---

## 📊 **Success Metrics**

### **Technical KPIs**:
- **Completion rate** >85% (users who start finish successfully)
- **Error rate** <5% (failed verifications)
- **Response time** <3 seconds average
- **Mobile compatibility** >95% success rate

### **User Experience KPIs**:
- **Time to complete** <60 seconds average  
- **User satisfaction** >4.5/5 rating
- **Support tickets** <2% of attempts
- **Retry rate** <10% of users

---

## 🆘 **Troubleshooting Guide**

### **Common Issues**:

| Issue | Cause | Solution |
|-------|-------|----------|
| "Invalid Telegram auth" | Hash verification failed | Check bot token, verify hash calculation |
| "Challenge expired" | >15 minutes elapsed | Generate fresh challenge |
| "Unauthorized bot" | Bot not using genesis key | Verify genesis private key |
| "Transaction failed" | Invalid transaction format | Check transaction structure |
| "Wallet won't sign" | Wrong network/format | Verify wallet connection |

### **Debug Tools**:
```typescript
// Add to dApp for debugging
const DEBUG_MODE = process.env.NODE_ENV === 'development'

if (DEBUG_MODE) {
  console.log('Challenge:', challenge)
  console.log('Signed challenge:', signedChallenge)  
  console.log('Unsigned transaction:', unsignedTransaction)
}
```

---

## 📞 **Support Contacts**

- **Node API Issues**: Backend team
- **Bot Integration**: Bot development team  
- **dApp Integration**: Frontend team
- **User Experience**: Product team

---

## 🎯 **Next Steps**

### **Immediate (Week 1)**:
1. **Bot team**: Set up Telegram bot with webhook endpoints
2. **dApp team**: Implement Telegram Login Widget
3. **Both teams**: Create communication protocol

### **Integration (Week 2)**:
1. **Test** individual components
2. **Connect** dApp ↔ Bot communication
3. **End-to-end** testing

### **Launch (Week 3)**:
1. **Production** deployment
2. **User** acceptance testing  
3. **Monitor** and optimize

**Total Estimated Time**: 2-3 weeks for both teams working in parallel.

---

**Questions? Contact the backend team for node API details or clarification on the integration flow.**