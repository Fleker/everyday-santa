export type GiftOccasionId =
  | 'birthday'
  | 'christmas'
  | 'mothers_day'
  | 'fathers_day'
  | 'anniversary';

export type ContactRelationship =
  | 'Mom'
  | 'Dad'
  | 'Partner'
  | 'Sibling'
  | 'Child'
  | 'Grandparent'
  | 'Friend'
  | 'Relative'
  | 'Colleague'
  | 'Other';

export type ProductCategory =
  | 'Coffee & Culinary'
  | 'Tech & Smart Home'
  | 'Books & Sci-Fi'
  | 'Outdoors & Travel'
  | 'Home & Cozy'
  | 'Wellness & Self-Care'
  | 'Apparel & Accessories'
  | 'Crafts, Games & Hobbies';

export type PricePresetId =
  | 'all'
  | 'under_35'
  | '35_to_75'
  | '75_to_150'
  | 'over_150';

export type GiftSortOption =
  | 'best_match'
  | 'price_asc'
  | 'price_desc'
  | 'fastest_delivery'
  | 'highest_rated';

export type SyncStatus =
  | 'synced'
  | 'dirty'
  | 'syncing'
  | 'error'
  | 'demo_local';

export interface BirthdayDate {
  year?: number;
  month: number; // 1-12
  day: number; // 1-31
}

export interface StructuredGiftProfile {
  freeformNotes: string;
  relationship: ContactRelationship;
  occasions: GiftOccasionId[];
  likes: string[];
  dislikes: string[];
  sizes: string;
  favoriteBrands: string[];
  targetBudget: {
    min: number;
    max: number;
  };
  pastGifts: string[];
}

export interface SantaContact {
  resourceName: string; // e.g. 'people/c123456789'
  etag: string; // Required by Google People API people.updateContact
  accountEmail: string;
  displayName: string;
  givenName: string;
  familyName: string;
  email?: string;
  photoUrl?: string;
  initials: string;
  avatarColor: string;
  birthday?: BirthdayDate;
  rawBiography: string; // Exact string in Google Contacts biographies[0].value
  giftProfile: StructuredGiftProfile;
  selectedForSanta: boolean; // Whether included in the user's active Gift Circle
  syncStatus: SyncStatus;
  lastSyncedAt?: string;
  syncError?: string;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  geminiApiKey?: string;
}

export interface ConnectedGoogleAccount {
  email: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  color: string;
  lastSyncAt?: string;
}

export interface OccasionMetadata {
  id: GiftOccasionId;
  label: string;
  shortLabel: string;
  icon: string;
  accentColor: string;
  badgeBg: string;
  description: string;
  nextDateIso: string;
  daysUntil: number;
}

export interface UpcomingOccasionEvent {
  contact: SantaContact;
  occasionId: GiftOccasionId;
  occasionLabel: string;
  dateLabel: string;
  daysUntil: number;
  turningAge?: number;
  icon: string;
  accentColor: string;
}

/**
 * Universal Commerce Protocol (UCP v2026-08-25) Models
 * Mirrors:
 * - //shopping/agent/nativecommerce/catalog/proto/catalog_service.proto
 * - //shopping/agent/merchantactions/proto/common/search_filters.proto
 * - //shopping/agent/merchantactions/proto/common/offer.proto
 * - https://ucp.dev/2026-08-25/specification/overview
 */
export interface UcpMoney {
  currencyCode: string;
  units: number;
  nanos?: number;
}

export interface UcpPriceFilter {
  min?: UcpMoney;
  max?: UcpMoney;
}

export interface UcpSearchFilters {
  categories: ProductCategory[];
  price?: UcpPriceFilter;
  additional_properties?: {
    in_stock_only?: boolean;
    free_shipping?: boolean;
    max_delivery_days?: number;
    free_returns?: boolean;
    one_click_ucp_checkout?: boolean;
    merchant_ids?: string[];
    min_rating?: number;
    occasion?: GiftOccasionId;
    search_keyword?: string;
    sort_by?: GiftSortOption;
  };
}

export interface UcpMerchantProfile {
  merchantId: string;
  merchantName: string;
  domain: string;
  wellKnownUri: string; // e.g. https://fellowproducts.com/.well-known/ucp
  ucpVersion: string; // e.g. '2026-08-25'
  transports: ('rest' | 'mcp' | 'embedded')[];
  capabilities: string[];
  paymentHandlers: string[];
  logoIcon: string;
  brandColor: string;
}

export interface UcpShippingAndReturnInfo {
  shippingPrice: UcpMoney;
  isFreeShipping: boolean;
  freeShippingThreshold?: UcpMoney;
  minDeliveryBusinessDays: number;
  maxDeliveryBusinessDays: number;
  returnWindowDays: number;
  freeReturn: boolean;
  freeInStoreReturn: boolean;
}

export interface UcpProductOption {
  name: string; // e.g. 'Color' or 'Size'
  values: string[];
}

export interface UcpSelectedOption {
  name: string;
  value: string;
}

export interface UcpOffer {
  offerDocid: string;
  cdsId: string;
  title: string;
  description: string;
  offerUrl: string;
  price: UcpMoney;
  originalPrice?: UcpMoney;
  formattedPrice: string;
  formattedOriginalPrice?: string;
  availability: 'IN_STOCK' | 'LIMITED_STOCK' | 'PREORDER' | 'OUT_OF_STOCK';
  countryCode: string;
  shippingAndReturnInfo: UcpShippingAndReturnInfo;
  isOneClickBuyAvailable: boolean;
}

export interface UcpDetailProduct {
  productId: string;
  variantId: string;
  merchant: UcpMerchantProfile;
  category: ProductCategory;
  offer: UcpOffer;
  selected: UcpSelectedOption[];
  options: UcpProductOption[];
  tags: string[];
  bestForOccasions: GiftOccasionId[];
  bestForRelationships: ContactRelationship[];
  rating: number;
  reviewCount: number;
  sustainabilityBadge?: string;
  visualEmoji: string;
  gradientBg: string;
}

export interface UcpSearchCatalogRequest {
  merchant?: {
    merchantId?: string;
    domain?: string;
  };
  query: string;
  filters: UcpSearchFilters;
  context: {
    locale: string;
    currencyCode: string;
    occasion: GiftOccasionId;
    recipientRelationship: ContactRelationship;
  };
  signals: {
    userAgent: string;
    surface: 'EVERYDAY_SANTA_WEB';
    timestamp: string;
  };
  pagination: {
    pageSize: number;
    pageToken?: string;
  };
}

export interface UcpSearchCatalogResponse {
  ucp: {
    version: string;
    capability: 'dev.ucp.shopping.catalog.search';
    transport: 'rest' | 'mcp' | 'embedded';
  };
  products: UcpDetailProduct[];
  pagination: {
    totalResults: number;
    nextPageToken?: string;
  };
}

export interface UcpCheckoutPayload {
  ucp: {
    version: string;
    capability: 'dev.ucp.shopping.checkout';
    merchantDomain: string;
    wellKnownUri: string;
  };
  line_items: Array<{
    product_id: string;
    variant_id: string;
    title: string;
    quantity: number;
    unit_price: UcpMoney;
    selected_options: UcpSelectedOption[];
  }>;
  buyer_context: {
    is_gift: boolean;
    gift_recipient_name: string;
    gift_occasion: string;
    gift_message_suggestion: string;
  };
  extensions: {
    'dev.ucp.shopping.fulfillment': {
      method: 'STANDARD_SHIPPING' | 'EXPRESS_SHIPPING';
      estimated_business_days: string;
      free_shipping_applied: boolean;
    };
  };
  payment_handlers: string[];
}

export interface GiftRecommendation {
  product: UcpDetailProduct;
  matchScore: number; // 0-100
  aiRationale: string;
  matchedSignals: string[];
  occasionFitLabel: string;
  ucpQueryUsed: string;
  savedByUser: boolean;
}

export interface SecondaryFilterState {
  categories: ProductCategory[];
  pricePreset: PricePresetId;
  minPrice: number | null;
  maxPrice: number | null;
  freeShippingOnly: boolean;
  fastDeliveryOnly: boolean; // <= 3 business days
  freeReturnsOnly: boolean;
  inStockOnly: boolean;
  oneClickUcpOnly: boolean;
  merchantId: string; // 'all' or specific merchantId
  minRating: number; // 0, 4.0, 4.5
  searchKeyword: string;
  sortBy: GiftSortOption;
}

export interface SavedGiftEntry {
  id: string;
  contactResourceName: string;
  contactName: string;
  occasionId: GiftOccasionId;
  productId: string;
  productTitle: string;
  merchantName: string;
  formattedPrice: string;
  offerUrl: string;
  savedAt: string;
  purchased: boolean;
}
