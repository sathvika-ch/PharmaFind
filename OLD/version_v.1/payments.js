/* ============================================================
   PharmaFind — payments.js   (ADD-ON, step 3)
   ------------------------------------------------------------
   Online payment with Razorpay Checkout: UPI (GPay, PhonePe,
   Paytm …), cards, netbanking and wallets — all inside
   Razorpay's own secure window. PharmaFind never sees a card
   number or UPI PIN.

   HOW TO TURN IT ON
     1. Create a free account at https://razorpay.com  (no KYC
        is needed for Test Mode).
     2. Dashboard → switch to "Test Mode" → Account & Settings →
        API Keys → Generate Test Key.
     3. Paste the KEY ID (it starts with  rzp_test_ ) below.
        NEVER paste the "Key Secret" here — this file is public.

   WHILE THE KEY IS EMPTY the app keeps using its old demo
   payment screen — nothing changes. Setting PAY_ENABLED to
   false does the same.

   WHAT THIS VERSION IS
     TEST MODE ONLY. It shows the real Razorpay window and takes
     Razorpay test cards / test UPI, so the whole flow can be
     demonstrated. No real money moves.

   WHY NOT LIVE MONEY YET
     Razorpay only keeps a real payment if an "order" was created
     first — and an order can only be created by a SERVER that
     holds the Key Secret. A payment made without an order is
     automatically refunded. The same server must also check the
     payment's signature, otherwise anyone could claim "I paid".
     That server is a Firebase Cloud Function, which needs the
     Blaze plan. Until then a live key (rzp_live_…) is refused
     here on purpose.
   ============================================================ */

export const PAY_ENABLED = true;

// ▼▼▼ paste your Razorpay TEST Key ID between the quotes ▼▼▼
export const RAZORPAY_KEY_ID = " rzp_test_TjqcMpp7lHcIX3";
// ▲▲▲ e.g. "rzp_test_AbCdEfGh123456" ▲▲▲

export const BUSINESS_NAME = "PharmaFind";
const THEME_COLOR  = "#0f8a6f";
const CHECKOUT_JS  = "https://checkout.razorpay.com/v1/checkout.js";
const MIN_RUPEES   = 1;                 // Razorpay's smallest payment
const MAX_RUPEES   = 500000;

let checkoutPromise = null;
let warned = false;


/* "test" when a usable test key is set, otherwise "" (= feature off). */
export function payMode(){
  if(!PAY_ENABLED) return "";
  const key = String(RAZORPAY_KEY_ID || "").trim();
  if(!key) return "";
  if(/^rzp_test_[A-Za-z0-9]{6,}$/.test(key)) return "test";

  if(!warned){
    warned = true;
    console.warn(/^rzp_live_/.test(key)
      ? "[payments.js] A LIVE Razorpay key was set. Live payments need a server (orders + signature check), so online payment stays OFF and the demo payment screen is used."
      : "[payments.js] RAZORPAY_KEY_ID doesn't look like a Razorpay Key ID (rzp_test_…). Online payment stays OFF.");
  }
  return "";
}

/* true when the Razorpay window can be used. */
export function payConfigured(){ return payMode() !== ""; }


/* Loads Razorpay's checkout script once, the first time someone pays. */
export function loadCheckout(){
  if(window.Razorpay) return Promise.resolve(window.Razorpay);
  if(checkoutPromise) return checkoutPromise;

  checkoutPromise = new Promise((resolve, reject) => {
    const fail = () => { checkoutPromise = null; reject(payError("load", "Couldn't open Razorpay. Check your internet connection (an ad-blocker can also block it) and try again.")); };
    const js = document.createElement("script");
    const timer = setTimeout(fail, 20000);
    js.src = CHECKOUT_JS;
    js.onload  = () => { clearTimeout(timer); window.Razorpay ? resolve(window.Razorpay) : fail(); };
    js.onerror = () => { clearTimeout(timer); fail(); };
    document.head.appendChild(js);
  });
  return checkoutPromise;
}

function payError(code, message){
  const e = new Error(message);
  e.payCode = code;                     // "load" | "cancelled" | "failed" | "amount" | "off"
  return e;
}

const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

/* Rupees → paise as a whole number (₹12.50 → 1250). */
export function toPaise(rupees){ return Math.round(Number(rupees) * 100); }


/* Opens the Razorpay window and waits for the result.

     amount      : rupees (e.g. 125.5)
     description : one line shown in the window ("2 × Dolo 650 — MedPlus")
     customer    : { name, email, phone }  (pre-fills the form)
     notes       : { anyKey: "value" }     (saved with the payment in the Razorpay dashboard)

   resolves { paymentId, mode }   — paymentId looks like "pay_Abc123…"
   rejects  an Error with .payCode:
     "cancelled" the patient closed the window (nothing charged)
     "load"      Razorpay couldn't be loaded
     "amount"    the amount is outside what Razorpay accepts
     "off"       no key configured                                                   */
export async function pay({ amount, description = "", customer = {}, notes = {} }){
  const mode = payMode();
  if(!mode) throw payError("off", "Online payment isn't set up.");

  const paise = toPaise(amount);
  if(!Number.isFinite(paise) || paise < MIN_RUPEES * 100) throw payError("amount", `Online payment needs at least ₹${MIN_RUPEES}.`);
  if(paise > MAX_RUPEES * 100) throw payError("amount", "This amount is too large to pay online.");

  const Razorpay = await loadCheckout();

  // Razorpay keeps up to 15 short notes with each payment.
  const cleanNotes = {};
  Object.keys(notes || {}).slice(0, 15).forEach(k => { cleanNotes[clip(k, 40)] = clip(notes[k], 250); });

  const prefill = {};
  if(customer.name)  prefill.name = clip(customer.name, 80);
  if(customer.email) prefill.email = clip(customer.email, 120);
  const phone = String(customer.phone || "").replace(/[^\d+]/g, "");
  if(phone.length >= 10) prefill.contact = phone;

  return new Promise((resolve, reject) => {
    let settled = false;
    let lastFailure = "";
    const settle = (fn, value) => { if(!settled){ settled = true; fn(value); } };

    let rzp;
    try{
      rzp = new Razorpay({
        key: String(RAZORPAY_KEY_ID).trim(),
        amount: paise,
        currency: "INR",
        name: BUSINESS_NAME,
        description: clip(description, 250),
        prefill,
        notes: cleanNotes,
        theme: { color: THEME_COLOR },
        retry: { enabled: true },
        modal: {
          confirm_close: true,                        // "are you sure?" before closing mid-payment
          ondismiss: () => settle(reject, payError("cancelled",
            lastFailure ? `Payment didn't go through (${lastFailure}). You were not charged.` : "Payment cancelled — you were not charged.")),
        },
        handler: (resp) => {
          const id = resp && resp.razorpay_payment_id;
          if(typeof id === "string" && /^pay_[A-Za-z0-9]+$/.test(id)) settle(resolve, { paymentId: id, mode });
          else settle(reject, payError("failed", "Razorpay didn't confirm the payment. If money left your account it will be refunded."));
        },
      });
      // A failed attempt keeps the window open so the patient can try another method.
      rzp.on("payment.failed", (r) => {
        lastFailure = clip((r && r.error && (r.error.description || r.error.reason)) || "payment failed", 140);
      });
      rzp.open();
    }catch(e){
      settle(reject, payError("load", "Couldn't open Razorpay. Please try again."));
    }
  });
}
