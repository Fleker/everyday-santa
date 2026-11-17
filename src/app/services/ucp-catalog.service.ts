import { Injectable, signal } from '@angular/core';
import {
  GiftOccasionId,
  ProductCategory,
  SantaContact,
  SecondaryFilterState,
  UcpCheckoutPayload,
  UcpDetailProduct,
  UcpMerchantProfile,
  UcpSearchCatalogRequest,
  UcpSearchCatalogResponse,
  UcpSearchFilters,
} from '../models/santa.model';

const CUSTOM_MERCHANTS_KEY = 'everyday_santa_ucp_merchants_v1';

export const ALL_PRODUCT_CATEGORIES: ProductCategory[] = [
  'Coffee & Culinary',
  'Tech & Smart Home',
  'Books & Sci-Fi',
  'Outdoors & Travel',
  'Home & Cozy',
  'Wellness & Self-Care',
  'Apparel & Accessories',
  'Crafts, Games & Hobbies',
];

@Injectable({
  providedIn: 'root',
})
export class UcpCatalogService {
  readonly merchants = signal<UcpMerchantProfile[]>(this.loadMerchants());
  readonly catalog = signal<UcpDetailProduct[]>(this.buildDefaultCatalog());
  readonly lastProbeResult = signal<string | null>(null);

  /**
   * Builds a spec-compliant UCP `SearchFilters` proto/JSON structure from UI filter state.
   * Mirrors `shopping.agent.merchantactions.proto.common.SearchFilters`.
   */
  buildUcpSearchFilters(
    filterState: SecondaryFilterState,
    occasion: GiftOccasionId
  ): UcpSearchFilters {
    let minUnits = filterState.minPrice;
    let maxUnits = filterState.maxPrice;

    if (filterState.pricePreset === 'under_35') {
      minUnits = 0;
      maxUnits = 35;
    } else if (filterState.pricePreset === '35_to_75') {
      minUnits = 35;
      maxUnits = 75;
    } else if (filterState.pricePreset === '75_to_150') {
      minUnits = 75;
      maxUnits = 150;
    } else if (filterState.pricePreset === 'over_150') {
      minUnits = 150;
      maxUnits = null;
    }

    const filters: UcpSearchFilters = {
      categories: [...filterState.categories],
      additional_properties: {
        in_stock_only: filterState.inStockOnly,
        free_shipping: filterState.freeShippingOnly,
        max_delivery_days: filterState.fastDeliveryOnly ? 3 : undefined,
        free_returns: filterState.freeReturnsOnly,
        one_click_ucp_checkout: filterState.oneClickUcpOnly,
        merchant_ids:
          filterState.merchantId && filterState.merchantId !== 'all'
            ? [filterState.merchantId]
            : undefined,
        min_rating:
          filterState.minRating > 0 ? filterState.minRating : undefined,
        occasion,
        search_keyword: filterState.searchKeyword.trim() || undefined,
        sort_by: filterState.sortBy,
      },
    };

    if (minUnits !== null || maxUnits !== null) {
      filters.price = {
        min:
          minUnits !== null
            ? { currencyCode: 'USD', units: minUnits }
            : undefined,
        max:
          maxUnits !== null
            ? { currencyCode: 'USD', units: maxUnits }
            : undefined,
      };
    }

    return filters;
  }

  /**
   * Executes a UCP `dev.ucp.shopping.catalog.search` (`SearchCatalogRequest`) query
   * and applies all primary + secondary `SearchFilters`.
   */
  searchCatalog(request: UcpSearchCatalogRequest): UcpSearchCatalogResponse {
    const filters = request.filters;
    const props = filters.additional_properties || {};

    const filtered = this.catalog().filter((item) => {
      // 1. Category filter (SearchFilters.categories)
      if (
        filters.categories &&
        filters.categories.length > 0 &&
        !filters.categories.includes(item.category)
      ) {
        return false;
      }

      // 2. Price filter (SearchFilters.price.min / max)
      const priceUnits = item.offer.price.units;
      if (filters.price?.min && priceUnits < filters.price.min.units) {
        return false;
      }
      if (filters.price?.max && priceUnits > filters.price.max.units) {
        return false;
      }

      // 3. In-stock filter
      if (props.in_stock_only && item.offer.availability === 'OUT_OF_STOCK') {
        return false;
      }

      // 4. Free shipping filter
      if (
        props.free_shipping &&
        !item.offer.shippingAndReturnInfo.isFreeShipping
      ) {
        return false;
      }

      // 5. Fast delivery filter (max_delivery_days)
      if (
        props.max_delivery_days !== undefined &&
        item.offer.shippingAndReturnInfo.maxDeliveryBusinessDays >
          props.max_delivery_days
      ) {
        return false;
      }

      // 6. Free returns filter
      if (props.free_returns && !item.offer.shippingAndReturnInfo.freeReturn) {
        return false;
      }

      // 7. 1-Click UCP Instant Checkout capability filter
      if (
        props.one_click_ucp_checkout &&
        !item.offer.isOneClickBuyAvailable
      ) {
        return false;
      }

      // 8. Merchant filter
      if (
        props.merchant_ids &&
        props.merchant_ids.length > 0 &&
        !props.merchant_ids.includes(item.merchant.merchantId)
      ) {
        return false;
      }

      // 9. Minimum rating filter
      if (props.min_rating !== undefined && item.rating < props.min_rating) {
        return false;
      }

      // 10. Keyword search within recommendations
      if (props.search_keyword) {
        const kw = props.search_keyword.toLowerCase();
        const haystack = [
          item.offer.title,
          item.offer.description,
          item.merchant.merchantName,
          item.category,
          ...item.tags,
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(kw)) {
          return false;
        }
      }

      return true;
    });

    return {
      ucp: {
        version: '2026-08-25',
        capability: 'dev.ucp.shopping.catalog.search',
        transport: 'rest',
      },
      products: filtered,
      pagination: {
        totalResults: filtered.length,
      },
    };
  }

  /**
   * Probes a merchant's `/.well-known/ucp` endpoint (or registers a simulated UCP profile
   * if CORS blocks direct browser access) and adds it to the UCP Merchant Registry.
   */
  async probeAndRegisterMerchantWellKnown(
    domainOrUrl: string,
    displayName?: string
  ): Promise<UcpMerchantProfile> {
    let cleanDomain = domainOrUrl
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/\.well-known\/ucp.*$/i, '')
      .replace(/\/+$/, '');

    if (!cleanDomain) {
      throw new Error('Enter a valid merchant domain (e.g. store.example.com).');
    }

    const wellKnownUri = `https://${cleanDomain}/.well-known/ucp`;
    let version = '2026-08-25';
    let capabilities = [
      'dev.ucp.shopping.catalog.search',
      'dev.ucp.shopping.catalog.lookup',
      'dev.ucp.shopping.cart',
      'dev.ucp.shopping.checkout',
      'dev.ucp.shopping.fulfillment',
    ];
    let paymentHandlers = ['com.google.pay'];
    let liveFetched = false;

    try {
      const res = await fetch(wellKnownUri, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const json = await res.json();
        if (json?.ucp) {
          liveFetched = true;
          version = json.ucp.version || version;
          if (json.ucp.capabilities && typeof json.ucp.capabilities === 'object') {
            capabilities = Object.keys(json.ucp.capabilities);
          }
          if (
            json.ucp.payment_handlers &&
            typeof json.ucp.payment_handlers === 'object'
          ) {
            paymentHandlers = Object.keys(json.ucp.payment_handlers);
          }
        }
      }
    } catch {
      // Expected if remote origin does not set Access-Control-Allow-Origin: *
    }

    const merchantId = `merchant-${cleanDomain.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;
    const merchantName =
      displayName?.trim() ||
      cleanDomain
        .split('.')[0]
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, (l) => l.toUpperCase());

    const profile: UcpMerchantProfile = {
      merchantId,
      merchantName,
      domain: cleanDomain,
      wellKnownUri,
      ucpVersion: version,
      transports: ['rest', 'mcp', 'embedded'],
      capabilities,
      paymentHandlers,
      logoIcon: 'storefront',
      brandColor: '#0f766e',
    };

    const existing = this.merchants().filter(
      (m) => m.merchantId !== merchantId
    );
    const updated = [profile, ...existing];
    this.merchants.set(updated);
    try {
      localStorage.setItem(CUSTOM_MERCHANTS_KEY, JSON.stringify(updated));
    } catch {
      // Ignore
    }

    this.lastProbeResult.set(
      liveFetched
        ? `Fetched live /.well-known/ucp profile from ${wellKnownUri} (v${version}, ${capabilities.length} capabilities).`
        : `Registered UCP profile for ${wellKnownUri} (v${version}, ${capabilities.length} capabilities).`
    );

    return profile;
  }

  /**
   * Builds a spec-compliant `/.well-known/ucp` JSON document (`2026-08-25`)
   * matching `//googledata/html/external_content/ucp_goog/.well-known/2026-08-25/ucp.json`.
   */
  buildWellKnownDocument(merchant: UcpMerchantProfile): Record<string, unknown> {
    const capabilitiesObj: Record<string, unknown> = {};
    for (const cap of merchant.capabilities) {
      const slug = cap.replace('dev.ucp.', '').replace(/\./g, '/');
      capabilitiesObj[cap] = [
        {
          version: merchant.ucpVersion,
          spec: `https://ucp.dev/${merchant.ucpVersion}/specification/${slug}`,
          schema: `https://ucp.dev/${merchant.ucpVersion}/schemas/${slug.replace(/\//g, '_')}.json`,
        },
      ];
    }

    return {
      ucp: {
        version: merchant.ucpVersion,
        services: {
          'dev.ucp.shopping': merchant.transports.map((t) => ({
            version: merchant.ucpVersion,
            spec: `https://ucp.dev/${merchant.ucpVersion}/specification/overview`,
            transport: t,
            schema: `https://ucp.dev/${merchant.ucpVersion}/services/shopping/${t === 'rest' ? 'rest.openapi.json' : t + '.openrpc.json'}`,
          })),
        },
        capabilities: capabilitiesObj,
        payment_handlers: {
          'com.google.pay': [
            {
              id: 'gpay_01_23',
              version: '2026-01-23',
              spec: 'https://pay.google.com/gp/p/ucp/2026-01-23',
              available_instruments: [
                {
                  type: 'card',
                  constraints: {
                    brands: ['amex', 'discover', 'mastercard', 'visa'],
                  },
                },
              ],
            },
          ],
        },
      },
    };
  }

  /**
   * Builds a UCP `dev.ucp.shopping.checkout` (`CreateCheckout`) payload for 1-click agentic buying.
   */
  buildUcpCheckoutPayload(
    product: UcpDetailProduct,
    contact: SantaContact,
    occasionId: GiftOccasionId
  ): UcpCheckoutPayload {
    const occasionNames: Record<GiftOccasionId, string> = {
      birthday: 'Happy Birthday',
      christmas: 'Merry Christmas',
      mothers_day: "Happy Mother's Day",
      fathers_day: "Happy Father's Day",
      anniversary: 'Happy Anniversary',
    };

    return {
      ucp: {
        version: product.merchant.ucpVersion,
        capability: 'dev.ucp.shopping.checkout',
        merchantDomain: product.merchant.domain,
        wellKnownUri: product.merchant.wellKnownUri,
      },
      line_items: [
        {
          product_id: product.productId,
          variant_id: product.variantId,
          title: product.offer.title,
          quantity: 1,
          unit_price: product.offer.price,
          selected_options: product.selected,
        },
      ],
      buyer_context: {
        is_gift: true,
        gift_recipient_name: contact.displayName,
        gift_occasion: occasionId,
        gift_message_suggestion: `${occasionNames[occasionId]}, ${contact.givenName}! Thought of you because of your love for ${contact.giftProfile.likes[0] || 'great design'}.`,
      },
      extensions: {
        'dev.ucp.shopping.fulfillment': {
          method:
            product.offer.shippingAndReturnInfo.maxDeliveryBusinessDays <= 2
              ? 'EXPRESS_SHIPPING'
              : 'STANDARD_SHIPPING',
          estimated_business_days: `${product.offer.shippingAndReturnInfo.minDeliveryBusinessDays}-${product.offer.shippingAndReturnInfo.maxDeliveryBusinessDays} business days`,
          free_shipping_applied:
            product.offer.shippingAndReturnInfo.isFreeShipping,
        },
      },
      payment_handlers: product.merchant.paymentHandlers,
    };
  }

  private loadMerchants(): UcpMerchantProfile[] {
    try {
      const raw = localStorage.getItem(CUSTOM_MERCHANTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // Ignore
    }
    return this.getDefaultMerchants();
  }

  getDefaultMerchants(): UcpMerchantProfile[] {
    const baseCaps = [
      'dev.ucp.shopping.catalog.search',
      'dev.ucp.shopping.catalog.lookup',
      'dev.ucp.shopping.cart',
      'dev.ucp.shopping.checkout',
      'dev.ucp.shopping.fulfillment',
      'dev.ucp.shopping.discount',
      'dev.ucp.shopping.permalink',
    ];
    return [
      {
        merchantId: 'fellow-coffee',
        merchantName: 'Fellow Products',
        domain: 'fellowproducts.com',
        wellKnownUri: 'https://fellowproducts.com/.well-known/ucp',
        ucpVersion: '2026-08-25',
        transports: ['rest', 'mcp', 'embedded'],
        capabilities: baseCaps,
        paymentHandlers: ['com.google.pay'],
        logoIcon: 'coffee_maker',
        brandColor: '#1c1917',
      },
      {
        merchantId: 'rei-coop',
        merchantName: 'REI Co-op',
        domain: 'rei.com',
        wellKnownUri: 'https://rei.com/.well-known/ucp',
        ucpVersion: '2026-08-25',
        transports: ['rest', 'mcp', 'embedded'],
        capabilities: [...baseCaps, 'dev.ucp.common.loyalty'],
        paymentHandlers: ['com.google.pay'],
        logoIcon: 'terrain',
        brandColor: '#15803d',
      },
      {
        merchantId: 'williams-sonoma',
        merchantName: 'Williams Sonoma',
        domain: 'williams-sonoma.com',
        wellKnownUri: 'https://williams-sonoma.com/.well-known/ucp',
        ucpVersion: '2026-08-25',
        transports: ['rest', 'embedded'],
        capabilities: baseCaps,
        paymentHandlers: ['com.google.pay'],
        logoIcon: 'restaurant',
        brandColor: '#b45309',
      },
      {
        merchantId: 'bookshop-org',
        merchantName: 'Bookshop.org',
        domain: 'bookshop.org',
        wellKnownUri: 'https://bookshop.org/.well-known/ucp',
        ucpVersion: '2026-08-25',
        transports: ['rest', 'mcp'],
        capabilities: baseCaps,
        paymentHandlers: ['com.google.pay'],
        logoIcon: 'menu_book',
        brandColor: '#7c2d12',
      },
      {
        merchantId: 'sonos-audio',
        merchantName: 'Sonos',
        domain: 'sonos.com',
        wellKnownUri: 'https://sonos.com/.well-known/ucp',
        ucpVersion: '2026-08-25',
        transports: ['rest', 'embedded'],
        capabilities: baseCaps,
        paymentHandlers: ['com.google.pay'],
        logoIcon: 'speaker',
        brandColor: '#1e293b',
      },
      {
        merchantId: 'uncommon-goods',
        merchantName: 'Uncommon Goods',
        domain: 'uncommongoods.com',
        wellKnownUri: 'https://uncommongoods.com/.well-known/ucp',
        ucpVersion: '2026-08-25',
        transports: ['rest', 'mcp', 'embedded'],
        capabilities: baseCaps,
        paymentHandlers: ['com.google.pay'],
        logoIcon: 'redeem',
        brandColor: '#0f766e',
      },
      {
        merchantId: 'lululemon',
        merchantName: 'Lululemon',
        domain: 'shop.lululemon.com',
        wellKnownUri: 'https://shop.lululemon.com/.well-known/ucp',
        ucpVersion: '2026-08-25',
        transports: ['rest', 'embedded'],
        capabilities: [...baseCaps, 'dev.ucp.common.loyalty'],
        paymentHandlers: ['com.google.pay'],
        logoIcon: 'self_improvement',
        brandColor: '#b91c1c',
      },
      {
        merchantId: 'lego-store',
        merchantName: 'LEGO Official',
        domain: 'lego.com',
        wellKnownUri: 'https://lego.com/.well-known/ucp',
        ucpVersion: '2026-08-25',
        transports: ['rest', 'mcp'],
        capabilities: [...baseCaps, 'dev.ucp.common.loyalty'],
        paymentHandlers: ['com.google.pay'],
        logoIcon: 'extension',
        brandColor: '#d97706',
      },
    ];
  }

  private buildDefaultCatalog(): UcpDetailProduct[] {
    const merchants = this.getDefaultMerchants();
    const byId = (id: string) =>
      merchants.find((m) => m.merchantId === id) || merchants[0];

    const items: Array<{
      id: string;
      merchantId: string;
      category: ProductCategory;
      title: string;
      description: string;
      price: number;
      originalPrice?: number;
      availability?: 'IN_STOCK' | 'LIMITED_STOCK';
      freeShipping: boolean;
      minDays: number;
      maxDays: number;
      freeReturn: boolean;
      oneClick: boolean;
      selected: Array<{ name: string; value: string }>;
      options: Array<{ name: string; values: string[] }>;
      tags: string[];
      occasions: GiftOccasionId[];
      relationships: SantaContact['giftProfile']['relationship'][];
      rating: number;
      reviews: number;
      sustainabilityBadge?: string;
      emoji: string;
      gradient: string;
      url: string;
    }> = [
      {
        id: 'ucp-prod-fellow-stagg-ekg-pro',
        merchantId: 'fellow-coffee',
        category: 'Coffee & Culinary',
        title: 'Fellow Stagg EKG Pro Studio Pour-Over Kettle (Walnut & Matte Black)',
        description:
          'Precision gooseneck temperature-controlled kettle with brew guide, scheduled boil timer, and walnut wood accents for specialty pour-over coffee and tea.',
        price: 195,
        originalPrice: 225,
        freeShipping: true,
        minDays: 1,
        maxDays: 2,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Finish', value: 'Matte Black + Walnut' }],
        options: [
          {
            name: 'Finish',
            values: ['Matte Black + Walnut', 'Warm White + Maple'],
          },
        ],
        tags: [
          'pour-over coffee',
          'coffee',
          'tea',
          'herbal tea',
          'matcha',
          'espresso',
          'fellow',
          'kitchen',
          'morning ritual',
        ],
        occasions: ['birthday', 'christmas', 'mothers_day', 'fathers_day', 'anniversary'],
        relationships: ['Mom', 'Dad', 'Partner', 'Sibling', 'Friend'],
        rating: 4.9,
        reviews: 1842,
        emoji: '☕',
        gradient: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)',
        url: 'https://fellowproducts.com/products/stagg-ekg-pro',
      },
      {
        id: 'ucp-prod-fellow-carter-mug-set',
        merchantId: 'fellow-coffee',
        category: 'Coffee & Culinary',
        title: 'Fellow Carter Move Insulated Ceramic Mug + Splash Guard (16 oz)',
        description:
          'True-taste ceramic interior vacuum-insulated mug that keeps pour-over coffee or cold brew hot for 12 hours or cold for 24 hours without metallic aftertaste.',
        price: 35,
        freeShipping: true,
        minDays: 2,
        maxDays: 3,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Color', value: 'Cargo Green' }],
        options: [
          { name: 'Color', values: ['Cargo Green', 'Matte Black', 'Sand Dune'] },
        ],
        tags: [
          'pour-over coffee',
          'cold brew',
          'coffee',
          'fellow',
          'travel',
          'commute',
          'stocking stuffer',
        ],
        occasions: ['birthday', 'christmas', 'mothers_day', 'fathers_day'],
        relationships: ['Mom', 'Dad', 'Sibling', 'Friend', 'Colleague'],
        rating: 4.8,
        reviews: 3110,
        sustainabilityBadge: 'Reusable Forever Guarantee',
        emoji: '🥤',
        gradient: 'linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%)',
        url: 'https://fellowproducts.com/products/carter-move-mug',
      },
      {
        id: 'ucp-prod-bookshop-cozy-scifi-box',
        merchantId: 'bookshop-org',
        category: 'Books & Sci-Fi',
        title: 'Signed Hardcover Sci-Fi Collection: Monk & Robot + Project Hail Mary',
        description:
          'Collector hardcover bundle featuring Becky Chambers’ complete Monk & Robot novellas and Andy Weir’s Project Hail Mary — supporting local independent bookstores.',
        price: 54,
        originalPrice: 62,
        freeShipping: true,
        minDays: 2,
        maxDays: 3,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Edition', value: 'Collector Hardcover Box' }],
        options: [{ name: 'Edition', values: ['Collector Hardcover Box'] }],
        tags: [
          'cozy sci-fi books',
          'sci-fi',
          'becky chambers',
          'project hail mary',
          'books',
          'reading',
          'hardcover',
          'bookshop.org',
        ],
        occasions: ['birthday', 'christmas', 'mothers_day', 'fathers_day'],
        relationships: ['Mom', 'Dad', 'Sibling', 'Friend', 'Partner'],
        rating: 4.9,
        reviews: 940,
        sustainabilityBadge: ' Certified B-Corp Indie Bookstores',
        emoji: '📚',
        gradient: 'linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%)',
        url: 'https://bookshop.org/',
      },
      {
        id: 'ucp-prod-uncommon-heirloom-garden-trug',
        merchantId: 'uncommon-goods',
        category: 'Outdoors & Travel',
        title: 'Handcrafted Maine Cedar Garden Harvest Hod & Japanese Hori-Hori Knife Set',
        description:
          'New England white pine & steam-bent oak harvest trug paired with a forged stainless-steel Japanese gardening weeding & planting trowel in a leather sheath.',
        price: 88,
        freeShipping: true,
        minDays: 2,
        maxDays: 3,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Size', value: '16-Quart Garden Hod + Hori Knife' }],
        options: [{ name: 'Size', values: ['16-Quart Garden Hod + Hori Knife'] }],
        tags: [
          'heirloom gardening',
          'gardening',
          'vegetable gardening',
          'botanical ceramics',
          'outdoors',
          'mom',
          'mothers day',
        ],
        occasions: ['mothers_day', 'birthday', 'christmas'],
        relationships: ['Mom', 'Grandparent', 'Relative'],
        rating: 4.9,
        reviews: 615,
        sustainabilityBadge: 'FSC Sustainably Harvested Timber',
        emoji: '🌿',
        gradient: 'linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%)',
        url: 'https://www.uncommongoods.com/garden',
      },
      {
        id: 'ucp-prod-rei-smartwool-merino-set',
        merchantId: 'rei-coop',
        category: 'Apparel & Accessories',
        title: 'Smartwool Classic Thermal Merino Quarter-Zip & National Parks Trail Gift Pack',
        description:
          '100% ZQ-certified Merino wool breathable midlayer paired with Cushion National Parks Edition trail socks for year-round hiking comfort.',
        price: 135,
        freeShipping: true,
        minDays: 1,
        maxDays: 2,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Size', value: 'Medium' }],
        options: [{ name: 'Size', values: ['Small', 'Medium', 'Large', 'XL'] }],
        tags: [
          'merino wool layers',
          'national park',
          'hiking',
          'trail running',
          'ultralight camping gear',
          'rei co-op',
          'sweater',
        ],
        occasions: ['christmas', 'birthday', 'mothers_day', 'fathers_day'],
        relationships: ['Mom', 'Dad', 'Friend', 'Partner', 'Sibling'],
        rating: 4.8,
        reviews: 1290,
        sustainabilityBadge: 'Climate Neutral & ZQ Merino',
        emoji: '🥾',
        gradient: 'linear-gradient(135deg, #fef9c3 0%, #fde047 100%)',
        url: 'https://www.rei.com/b/smartwool',
      },
      {
        id: 'ucp-prod-ws-smithey-cast-iron',
        merchantId: 'williams-sonoma',
        category: 'Coffee & Culinary',
        title: 'Smithey No. 12 Polished Heirloom Cast-Iron Skillet + Personalized Engraving',
        description:
          'Charleston-forged satin-smooth interior cast-iron skillet designed for backyard smoking, sear-roasting steaks, and passing down for generations.',
        price: 210,
        freeShipping: true,
        minDays: 2,
        maxDays: 3,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Size', value: '12-Inch Skillet + Chainmail Scrubber' }],
        options: [{ name: 'Size', values: ['10-Inch Skillet', '12-Inch Skillet + Chainmail Scrubber'] }],
        tags: [
          'cast-iron cooking',
          'bbq & smoking',
          'grilling',
          'cooking',
          'sourdough baking',
          'williams sonoma',
          'dad',
          'fathers day',
        ],
        occasions: ['fathers_day', 'christmas', 'birthday', 'anniversary'],
        relationships: ['Dad', 'Partner', 'Mom', 'Friend'],
        rating: 4.9,
        reviews: 820,
        emoji: '🍳',
        gradient: 'linear-gradient(135deg, #ffedd5 0%, #fed7aa 100%)',
        url: 'https://www.williams-sonoma.com/shop/cookware/cast-iron-cookware/',
      },
      {
        id: 'ucp-prod-ws-meater-pro-duo',
        merchantId: 'williams-sonoma',
        category: 'Coffee & Culinary',
        title: 'MEATER Pro XL Wi-Fi Smart Meat Thermometer (1000°F Direct Flame Rated)',
        description:
          'Dual-sensor wireless smart probe thermometer with bamboo charging block, cloud BBQ smoke graph tracking, and 5-sensor internal core accuracy for brisket and ribs.',
        price: 129,
        originalPrice: 149,
        freeShipping: true,
        minDays: 1,
        maxDays: 2,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Model', value: 'MEATER Pro 1000°F' }],
        options: [{ name: 'Model', values: ['MEATER Pro 1000°F', 'MEATER Pro Duo'] }],
        tags: [
          'bbq & smoking',
          'cast-iron cooking',
          'dad',
          'fathers day',
          'cooking',
          'smart home',
          'williams sonoma',
        ],
        occasions: ['fathers_day', 'birthday', 'christmas'],
        relationships: ['Dad', 'Partner', 'Sibling', 'Friend'],
        rating: 4.7,
        reviews: 2150,
        emoji: '🥩',
        gradient: 'linear-gradient(135deg, #fee2e2 0%, #fecaca 100%)',
        url: 'https://www.williams-sonoma.com/',
      },
      {
        id: 'ucp-prod-sonos-era-100',
        merchantId: 'sonos-audio',
        category: 'Tech & Smart Home',
        title: 'Sonos Era 100 Wireless Bookshelf Speaker with Line-In Turntable Support',
        description:
          'Next-gen stereo acoustics with Trueplay room tuning, Wi-Fi/Bluetooth, and direct line-in capability for vinyl record turntables.',
        price: 249,
        freeShipping: true,
        minDays: 1,
        maxDays: 2,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Color', value: 'Matte Black' }],
        options: [{ name: 'Color', values: ['Matte Black', 'Lunar White'] }],
        tags: [
          'vinyl jazz records',
          'compact wireless audio',
          'music',
          'audiobooks',
          'sonos',
          'speaker',
          'dad',
          'partner',
        ],
        occasions: ['fathers_day', 'christmas', 'birthday', 'anniversary'],
        relationships: ['Dad', 'Partner', 'Sibling', 'Mom'],
        rating: 4.8,
        reviews: 1640,
        emoji: '🔊',
        gradient: 'linear-gradient(135deg, #f1f5f9 0%, #cbd5e1 100%)',
        url: 'https://www.sonos.com/en-us/shop/era-100',
      },
      {
        id: 'ucp-prod-sonos-roam-2',
        merchantId: 'sonos-audio',
        category: 'Tech & Smart Home',
        title: 'Sonos Roam 2 Ultralight Waterproof Portable Smart Speaker',
        description:
          'IP67 waterproof & dustproof portable Bluetooth + Wi-Fi speaker for garden mornings, stroller walks, and cabin weekends with 10-hour battery.',
        price: 179,
        freeShipping: true,
        minDays: 1,
        maxDays: 2,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Color', value: 'Olive Green' }],
        options: [
          { name: 'Color', values: ['Olive Green', 'Sunset Orange', 'Shadow Black'] },
        ],
        tags: [
          'compact wireless audio',
          'audiobooks',
          'outdoors',
          'gardening',
          'sonos',
          'travel',
        ],
        occasions: ['birthday', 'christmas', 'mothers_day', 'fathers_day'],
        relationships: ['Mom', 'Dad', 'Relative', 'Partner', 'Friend'],
        rating: 4.7,
        reviews: 980,
        emoji: '🎶',
        gradient: 'linear-gradient(135deg, #ecfccb 0%, #d9f99d 100%)',
        url: 'https://www.sonos.com/en-us/shop/roam-2',
      },
      {
        id: 'ucp-prod-uncommon-ceremonial-matcha-set',
        merchantId: 'uncommon-goods',
        category: 'Coffee & Culinary',
        title: 'Kyoto Studio Ceramic Matcha Bowl, 100-Prong Bamboo Chasen & Uji First-Harvest Tin',
        description:
          'Wheel-thrown speckled stoneware chawan with pouring spout, hand-carved bamboo whisk, chashaku scoop, and organic Uji ceremonial-grade matcha.',
        price: 92,
        freeShipping: true,
        minDays: 2,
        maxDays: 3,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Glaze', value: 'Moss & Warm Stone' }],
        options: [{ name: 'Glaze', values: ['Moss & Warm Stone', 'Snow Ash'] }],
        tags: [
          'ceremonial matcha',
          'matcha',
          'botanical ceramics',
          'ceramic studio pottery',
          'herbal tea & wellness',
          'partner',
          'mom',
        ],
        occasions: ['birthday', 'christmas', 'mothers_day', 'anniversary'],
        relationships: ['Partner', 'Mom', 'Relative', 'Friend'],
        rating: 4.9,
        reviews: 540,
        sustainabilityBadge: 'Small-Batch Artisan Studio',
        emoji: '🍵',
        gradient: 'linear-gradient(135deg, #dcfce7 0%, #86efac 100%)',
        url: 'https://www.uncommongoods.com/',
      },
      {
        id: 'ucp-prod-uncommon-minimalist-brass-lamp',
        merchantId: 'uncommon-goods',
        category: 'Home & Cozy',
        title: 'Cordless Architectural Brushed Brass & Opal Glass Table Lamp',
        description:
          'Warm-dimming (2200K–3000K) touch-controlled architectural accent lamp with 40-hour USB-C rechargeable battery for reading nooks and dining tables.',
        price: 145,
        freeShipping: true,
        minDays: 2,
        maxDays: 3,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Finish', value: 'Brushed Aged Brass' }],
        options: [{ name: 'Finish', values: ['Brushed Aged Brass', 'Matte Bronze'] }],
        tags: [
          'minimalist lamps & design',
          'smart desk lighting',
          'architecture',
          'home & cozy',
          'partner',
          'anniversary',
        ],
        occasions: ['anniversary', 'birthday', 'christmas', 'mothers_day'],
        relationships: ['Partner', 'Mom', 'Sibling'],
        rating: 4.8,
        reviews: 412,
        emoji: '🏮',
        gradient: 'linear-gradient(135deg, #fef3c7 0%, #fcd34d 100%)',
        url: 'https://www.uncommongoods.com/',
      },
      {
        id: 'ucp-prod-lululemon-weekender-bag',
        merchantId: 'lululemon',
        category: 'Outdoors & Travel',
        title: 'Lululemon Daily Multi-Pocket Canvas & Water-Repellent Cabin Weekender (29L)',
        description:
          'Structured minimalist weekender bag with padded 16" laptop sleeve, trolley pass-through strap, and separate shoe/laundry compartment for weekend cabin getaways.',
        price: 168,
        freeShipping: true,
        minDays: 1,
        maxDays: 2,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Color', value: 'Trench / Espresso' }],
        options: [{ name: 'Color', values: ['Trench / Espresso', 'Black', 'Raw Linen'] }],
        tags: [
          'travel weekender bags',
          'cabin trips',
          'cozy loungewear',
          'yoga & recovery',
          'lululemon',
          'partner',
          'mothers day',
        ],
        occasions: ['birthday', 'christmas', 'mothers_day', 'anniversary'],
        relationships: ['Partner', 'Mom', 'Relative', 'Sibling'],
        rating: 4.9,
        reviews: 1120,
        emoji: '👜',
        gradient: 'linear-gradient(135deg, #f5f5f4 0%, #e7e5e4 100%)',
        url: 'https://shop.lululemon.com/',
      },
      {
        id: 'ucp-prod-lego-dune-ornithopter',
        merchantId: 'lego-store',
        category: 'Crafts, Games & Hobbies',
        title: 'LEGO Icons Dune Atreides Royal Ornithopter Collector Set (1,369 Pieces)',
        description:
          'Display-grade adult collector build with fold-out flapping wings, deployable landing gear, and 8 minifigure characters from Dune.',
        price: 134,
        originalPrice: 164,
        freeShipping: true,
        minDays: 2,
        maxDays: 3,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Set', value: '10327 Collector Edition' }],
        options: [{ name: 'Set', values: ['10327 Collector Edition'] }],
        tags: [
          'lego collector sets',
          'strategy board games',
          'dune',
          'sci-fi',
          'lego',
          'sibling',
        ],
        occasions: ['birthday', 'christmas', 'fathers_day'],
        relationships: ['Sibling', 'Dad', 'Friend', 'Partner'],
        rating: 4.9,
        reviews: 2430,
        emoji: '🧱',
        gradient: 'linear-gradient(135deg, #ffedd5 0%, #fdba74 100%)',
        url: 'https://www.lego.com/en-us/product/dune-atreides-royal-ornithopter-10327',
      },
      {
        id: 'ucp-prod-lego-botanical-bonsai',
        merchantId: 'lego-store',
        category: 'Crafts, Games & Hobbies',
        title: 'LEGO Botanical Collection Japanese Red Maple Bonsai & Orchid Display Bundle',
        description:
          'Mindful architectural build featuring interchangeable seasonal foliage and a slatted wood-effect display pedestal.',
        price: 69,
        freeShipping: true,
        minDays: 2,
        maxDays: 3,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Style', value: 'Botanical Zen Bundle' }],
        options: [{ name: 'Style', values: ['Botanical Zen Bundle'] }],
        tags: [
          'lego collector sets',
          'botanical ceramics',
          'gardening',
          'minimalist lamps & design',
          'mothers day',
        ],
        occasions: ['mothers_day', 'birthday', 'christmas'],
        relationships: ['Mom', 'Partner', 'Sibling', 'Friend'],
        rating: 4.9,
        reviews: 3890,
        sustainabilityBadge: 'Plant-Based Polyethylene Elements',
        emoji: '🌸',
        gradient: 'linear-gradient(135deg, #fce7f3 0%, #fbcfe8 100%)',
        url: 'https://www.lego.com/en-us/themes/adults-welcome/botanical-collection',
      },
      {
        id: 'ucp-prod-rei-leatherman-arc',
        merchantId: 'rei-coop',
        category: 'Outdoors & Travel',
        title: 'Leatherman ARC MagnaCut Steel 20-in-1 Precision Everyday Multi-Tool',
        description:
          'First multi-tool crafted with ultra-corrosion-resistant CPM MagnaCut blade steel and one-handed magnetic FREE technology.',
        price: 149,
        freeShipping: true,
        minDays: 1,
        maxDays: 2,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Sheath', value: 'Nylon Carry Sheath + Bit Kit' }],
        options: [{ name: 'Sheath', values: ['Nylon Carry Sheath + Bit Kit'] }],
        tags: [
          'precision pocket tools',
          'ultralight camping gear',
          'dad',
          'fathers day',
          'rei co-op',
          'outdoors',
        ],
        occasions: ['fathers_day', 'birthday', 'christmas'],
        relationships: ['Dad', 'Sibling', 'Friend', 'Partner'],
        rating: 4.9,
        reviews: 760,
        emoji: '🛠️',
        gradient: 'linear-gradient(135deg, #e2e8f0 0%, #94a3b8 100%)',
        url: 'https://www.rei.com/product/229795/leatherman-arc-multi-tool',
      },
      {
        id: 'ucp-prod-rei-jetboil-stash',
        merchantId: 'rei-coop',
        category: 'Outdoors & Travel',
        title: 'Jetboil Stash 7.1 oz Ultralight Titanium Backpacking Stove System',
        description:
          'Featherweight 7.1-ounce nesting FluxRing cook pot and titanium burner that boils 0.5L of trail coffee water in 2.5 minutes.',
        price: 98,
        originalPrice: 129,
        freeShipping: true,
        minDays: 1,
        maxDays: 3,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Volume', value: '0.8L Nesting System' }],
        options: [{ name: 'Volume', values: ['0.8L Nesting System'] }],
        tags: [
          'ultralight camping gear',
          'trail running',
          'national park maps',
          'hiking',
          'rei co-op',
          'friend',
        ],
        occasions: ['birthday', 'christmas', 'fathers_day'],
        relationships: ['Friend', 'Sibling', 'Dad', 'Partner'],
        rating: 4.8,
        reviews: 645,
        emoji: '⛺',
        gradient: 'linear-gradient(135deg, #dbeafe 0%, #93c5fd 100%)',
        url: 'https://www.rei.com/product/187624/jetboil-stash-cooking-system',
      },
      {
        id: 'ucp-prod-ws-sourdough-challenger-kit',
        merchantId: 'williams-sonoma',
        category: 'Coffee & Culinary',
        title: 'Artisan French Rattan Banneton Proofing Basket, Lame & Danish Dough Whisk Set',
        description:
          'Complete artisan sourdoughboule shaping kit with natural Indonesian rattan bannetons,linen liners, walnut bread lame, and bench scraper.',
        price: 58,
        freeShipping: true,
        minDays: 2,
        maxDays: 3,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Shape', value: '9" Round + 10" Oval Set' }],
        options: [{ name: 'Shape', values: ['9" Round + 10" Oval Set'] }],
        tags: [
          'sourdough baking',
          'cooking',
          'williams sonoma',
          'kitchen',
          'friend',
          'mom',
        ],
        occasions: ['birthday', 'christmas', 'mothers_day', 'fathers_day'],
        relationships: ['Friend', 'Mom', 'Dad', 'Partner'],
        rating: 4.8,
        reviews: 512,
        emoji: '🥖',
        gradient: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)',
        url: 'https://www.williams-sonoma.com/',
      },
      {
        id: 'ucp-prod-lululemon-scuba-plush-set',
        merchantId: 'lululemon',
        category: 'Wellness & Self-Care',
        title: 'Lululemon Softstreme Relaxed Loungewear Set & Mulberry Silk Sleep Mask',
        description:
          'Peach-fuzz soft modal loungewear pullover paired with a pure 22-momme mulberry silk eye mask for restorative post-yoga relaxation.',
        price: 128,
        freeShipping: true,
        minDays: 1,
        maxDays: 2,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Size', value: 'S/M — Bone White' }],
        options: [{ name: 'Size', values: ['XS/S', 'S/M — Bone White', 'M/L'] }],
        tags: [
          'cozy loungewear',
          'yoga & recovery',
          'herbal tea & wellness',
          'lululemon',
          'mothers day',
          'mom',
        ],
        occasions: ['mothers_day', 'birthday', 'christmas', 'anniversary'],
        relationships: ['Mom', 'Relative', 'Partner'],
        rating: 4.9,
        reviews: 1470,
        emoji: '🧘‍♀️',
        gradient: 'linear-gradient(135deg, #fce7f3 0%, #f9a8d4 100%)',
        url: 'https://shop.lululemon.com/',
      },
      {
        id: 'ucp-prod-uncommon-hinoki-spa-diffuser',
        merchantId: 'uncommon-goods',
        category: 'Wellness & Self-Care',
        title: 'Japanese Kiso Hinoki Cypress Essential Oil & Hand-Thrown Stone Diffuser',
        description:
          'Sustainably distilled Japanese Kiso Forest hinoki wood essential oil with a porous volcanic ceramic stone diffuser — calm cedar-citrus warmth with zero synthetic fragrance.',
        price: 64,
        freeShipping: true,
        minDays: 2,
        maxDays: 3,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Set', value: 'Stone Diffuser + 15ml Hinoki Oil' }],
        options: [{ name: 'Set', values: ['Stone Diffuser + 15ml Hinoki Oil'] }],
        tags: [
          'spa & hinoki wood scents',
          'herbal tea & wellness',
          'minimalist lamps & design',
          'yoga & recovery',
          'partner',
          'mothers day',
        ],
        occasions: ['birthday', 'christmas', 'mothers_day', 'anniversary'],
        relationships: ['Partner', 'Mom', 'Relative', 'Friend'],
        rating: 4.8,
        reviews: 390,
        sustainabilityBadge: '100% Pure Forest Botanical — Zero Synthetics',
        emoji: '🌲',
        gradient: 'linear-gradient(135deg, #ccfbf1 0%, #99f6e4 100%)',
        url: 'https://www.uncommongoods.com/',
      },
      {
        id: 'ucp-prod-bookshop-architecture-taschen',
        merchantId: 'bookshop-org',
        category: 'Books & Sci-Fi',
        title: 'TASCHEN Ando: Complete Works Architecture Monograph (XXL Linen Hardcover)',
        description:
          'Folio-sized architectural monograph celebrating Tadao Ando’s serene concrete, light, and water structures with fold-out blueprints and sketches.',
        price: 85,
        freeShipping: true,
        minDays: 2,
        maxDays: 3,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Format', value: 'XXL Linen Hardcover' }],
        options: [{ name: 'Format', values: ['XXL Linen Hardcover'] }],
        tags: [
          'art & architecture monographs',
          'minimalist lamps & design',
          'taschen',
          'books',
          'partner',
        ],
        occasions: ['birthday', 'christmas', 'anniversary'],
        relationships: ['Partner', 'Friend', 'Sibling'],
        rating: 4.9,
        reviews: 320,
        emoji: '🏛️',
        gradient: 'linear-gradient(135deg, #e5e7eb 0%, #d1d5db 100%)',
        url: 'https://bookshop.org/',
      },
      {
        id: 'ucp-prod-bookshop-jazz-vinyl-odyssey',
        merchantId: 'bookshop-org',
        category: 'Books & Sci-Fi',
        title: 'Blue Note Records: The Classic Vinyl Sleeve Visual History + LP Cleaning Brush',
        description:
          'Archival coffee-table chronicle of Blue Note’s golden-era jazz album art paired with an anti-static carbon fiber vinyl record brush.',
        price: 68,
        freeShipping: true,
        minDays: 2,
        maxDays: 3,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Bundle', value: 'Hardcover + Carbon LP Brush' }],
        options: [{ name: 'Bundle', values: ['Hardcover + Carbon LP Brush'] }],
        tags: [
          'vinyl jazz records',
          'history & biography books',
          'music',
          'dad',
          'fathers day',
          'books',
        ],
        occasions: ['fathers_day', 'birthday', 'christmas'],
        relationships: ['Dad', 'Partner', 'Friend'],
        rating: 4.9,
        reviews: 475,
        emoji: '🎷',
        gradient: 'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)',
        url: 'https://bookshop.org/',
      },
      {
        id: 'ucp-prod-fellow-atmos-espresso-bundle',
        merchantId: 'fellow-coffee',
        category: 'Coffee & Culinary',
        title: 'Fellow Atmos Vacuum Canister + Monty Double-Wall Latte Art Cappuccino Cups',
        description:
          'Integrated vacuum-pump bean canister that prevents oxidation paired with two hidden-parabolic-slope ceramic espresso/cappuccino cups.',
        price: 72,
        freeShipping: true,
        minDays: 1,
        maxDays: 2,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Finish', value: 'Matte Black + Copper Base' }],
        options: [
          { name: 'Finish', values: ['Matte Black + Copper Base', 'Matte White'] },
        ],
        tags: [
          'espresso accessories',
          'pour-over coffee',
          'coffee',
          'fellow',
          'botanical ceramics',
          'sibling',
          'mom',
        ],
        occasions: ['birthday', 'christmas', 'mothers_day', 'fathers_day'],
        relationships: ['Sibling', 'Mom', 'Dad', 'Partner', 'Friend'],
        rating: 4.8,
        reviews: 1180,
        emoji: '🫘',
        gradient: 'linear-gradient(135deg, #f3e8ff 0%, #e9d5ff 100%)',
        url: 'https://fellowproducts.com/products/atmos-vacuum-canister',
      },
      {
        id: 'ucp-prod-uncommon-watercolor-field-kit',
        merchantId: 'uncommon-goods',
        category: 'Crafts, Games & Hobbies',
        title: 'Pocket Walnut plein-air Watercolor Palette, Water Brush & Cold-Press Sketchbook',
        description:
          'Hand-oiled American black walnut magnetic travel palette filled with 12 artist-grade pigments and a 300gsm cotton watercolor field journal.',
        price: 56,
        freeShipping: true,
        minDays: 2,
        maxDays: 4,
        freeReturn: true,
        oneClick: false,
        selected: [{ name: 'Palette', value: '12-Pan Botanical Set' }],
        options: [{ name: 'Palette', values: ['12-Pan Botanical Set'] }],
        tags: [
          'watercolor painting',
          'birdwatching',
          'art',
          'outdoors',
          'mothers day',
          'relative',
        ],
        occasions: ['birthday', 'christmas', 'mothers_day'],
        relationships: ['Relative', 'Mom', 'Friend', 'Partner'],
        rating: 4.7,
        reviews: 295,
        emoji: '🎨',
        gradient: 'linear-gradient(135deg, #fae8ff 0%, #f5d0fe 100%)',
        url: 'https://www.uncommongoods.com/',
      },
      {
        id: 'ucp-prod-uncommon-dune-imperium-uprising',
        merchantId: 'uncommon-goods',
        category: 'Crafts, Games & Hobbies',
        title: 'Dune: Imperium — Uprising Deluxe Wooden Token & Deck-Building Strategy Box',
        description:
          'Stand-alone expansion to the award-winning deck-building & worker-placement board game with custom wooden sandworm miniatures and card sleeves.',
        price: 65,
        freeShipping: true,
        minDays: 2,
        maxDays: 3,
        freeReturn: true,
        oneClick: true,
        selected: [{ name: 'Edition', value: 'Core Game + Wooden Token Upgrade' }],
        options: [{ name: 'Edition', values: ['Core Game + Wooden Token Upgrade'] }],
        tags: [
          'strategy board games',
          'sci-fi',
          'lego collector sets',
          'sibling',
          'friend',
        ],
        occasions: ['birthday', 'christmas'],
        relationships: ['Sibling', 'Friend', 'Partner'],
        rating: 4.9,
        reviews: 890,
        emoji: '🎲',
        gradient: 'linear-gradient(135deg, #fef3c7 0%, #f59e0b 100%)',
        url: 'https://www.uncommongoods.com/',
      },
    ];

    return items.map((raw, idx) => {
      const merchant = byId(raw.merchantId);
      return {
        productId: raw.id,
        variantId: `${raw.id}-v1`,
        merchant,
        category: raw.category,
        offer: {
          offerDocid: `${9800100 + idx}`,
          cdsId: `cds-${raw.id}`,
          title: raw.title,
          description: raw.description,
          offerUrl: raw.url,
          price: { currencyCode: 'USD', units: raw.price },
          originalPrice: raw.originalPrice
            ? { currencyCode: 'USD', units: raw.originalPrice }
            : undefined,
          formattedPrice: `$${raw.price}`,
          formattedOriginalPrice: raw.originalPrice
            ? `$${raw.originalPrice}`
            : undefined,
          availability: raw.availability || 'IN_STOCK',
          countryCode: 'US',
          shippingAndReturnInfo: {
            shippingPrice: {
              currencyCode: 'USD',
              units: raw.freeShipping ? 0 : 7,
            },
            isFreeShipping: raw.freeShipping,
            freeShippingThreshold: { currencyCode: 'USD', units: 50 },
            minDeliveryBusinessDays: raw.minDays,
            maxDeliveryBusinessDays: raw.maxDays,
            returnWindowDays: 45,
            freeReturn: raw.freeReturn,
            freeInStoreReturn: true,
          },
          isOneClickBuyAvailable: raw.oneClick,
        },
        selected: raw.selected,
        options: raw.options,
        tags: raw.tags,
        bestForOccasions: raw.occasions,
        bestForRelationships: raw.relationships,
        rating: raw.rating,
        reviewCount: raw.reviews,
        sustainabilityBadge: raw.sustainabilityBadge,
        visualEmoji: raw.emoji,
        gradientBg: raw.gradient,
      };
    });
  }
}
