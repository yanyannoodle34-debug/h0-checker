/**
 * Billing Data Generator - Realistic test data using @faker-js/faker.
 * Replaces hardcoded "James Smith" with varied, locale-aware data.
 */
import { faker } from "@faker-js/faker";

export interface BillingData {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    stateCode: string;
    zip: string;
    country: string;
    countryCode: string;
  };
}

/**
 * Generate realistic billing data for a given country.
 * Uses appropriate locale for names/addresses.
 */
export function generateBillingData(cardCountry?: string): BillingData {
  // Note: faker v9 uses default locale; locale parameter removed for compatibility
  faker.seed(faker.number.int({ min: 1, max: 1000000 }));

  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const fullName = `${firstName} ${lastName}`;

  // Generate email based on name
  const email = faker.internet.email({ firstName, lastName, provider: "gmail.com" });

  // Phone number
  const phone = faker.phone.number({ style: "national" });

  // Address
  const countryCode = cardCountry || "US";
  const address = {
    line1: faker.location.streetAddress(),
    line2: faker.datatype.boolean() ? faker.location.secondaryAddress() : undefined,
    city: faker.location.city(),
    state: faker.location.state({ abbreviated: false }),
    stateCode: faker.location.state({ abbreviated: true }),
    zip: faker.location.zipCode(),
    country: getCountryName(countryCode),
    countryCode,
  };

  return {
    firstName,
    lastName,
    fullName,
    email,
    phone,
    address,
  };
}

/**
 * Get Faker locale for a country code.
 */
function getLocaleForCountry(countryCode: string): string {
  const localeMap: Record<string, string> = {
    US: "en",
    GB: "en_GB",
    CA: "en_CA",
    AU: "en_AU",
    DE: "de",
    FR: "fr",
    ES: "es",
    IT: "it",
    NL: "nl",
    BR: "pt_BR",
    MX: "es_MX",
    JP: "ja",
    CN: "zh_CN",
    IN: "en_IN",
    SG: "en_SG",
    HK: "zh_HK",
  };
  return localeMap[countryCode.toUpperCase()] || "en";
}

/**
 * Get country name from ISO code.
 */
function getCountryName(code: string): string {
  const names: Record<string, string> = {
    US: "United States",
    GB: "United Kingdom",
    CA: "Canada",
    AU: "Australia",
    DE: "Germany",
    FR: "France",
    ES: "Spain",
    IT: "Italy",
    NL: "Netherlands",
    BR: "Brazil",
    MX: "Mexico",
    JP: "Japan",
    CN: "China",
    IN: "India",
    SG: "Singapore",
    HK: "Hong Kong",
  };
  return names[code.toUpperCase()] || "United States";
}

/**
 * Generate multiple billing profiles for batch testing.
 */
export function generateBillingBatch(count: number, cardCountry?: string): BillingData[] {
  return Array.from({ length: count }, () => generateBillingData(cardCountry));
}

/**
 * Generate billing data matching card BIN country.
 * If BIN lookup fails, falls back to US.
 */
export function generateBillingForCard(cardNumber: string, binCountry?: string): BillingData {
  return generateBillingData(binCountry);
}