import { Injectable, inject, signal } from '@angular/core';
import {
  GiftOccasionId,
  GiftRecommendation,
  SantaContact,
  SavedGiftEntry,
  SecondaryFilterState,
  UcpDetailProduct,
  UcpSearchCatalogRequest,
} from '../models/santa.model';
import { UcpCatalogService } from './ucp-catalog.service';

const SAVED_GIFTS_STORAGE_KEY = 'everyday_santa_saved_gifts_v1';

export interface AiCustomPromptIdea {
  title: string;
  category: string;
  estimatedPrice: string;
  whyItFits: string;
  ucpSearchQuery: string;
}

@Injectable({
  providedIn: 'root',
})
export class AiGiftEngineService {
  private readonly ucpCatalog = inject(UcpCatalogService);

  readonly savedGifts = signal<SavedGiftEntry[]>(this.loadSavedGifts());
  readonly isGeneratingGemini = signal<boolean>(false);
  readonly customAiIdeas = signal<Record<string, AiCustomPromptIdea[]>>({});
  readonly aiStatusMessage = signal<string | null>(null);

  /**
   * Synthesizes a formal UCP `SearchCatalogRequest` (`dev.ucp.shopping.catalog.search`)
   * combining the AI-extracted query from the contact's notes with secondary product filters.
   */
  buildUcpSearchRequest(
    contact: SantaContact,
    occasionId: GiftOccasionId,
    filterState: SecondaryFilterState
  ): UcpSearchCatalogRequest {
    const occasionTerms: Record<GiftOccasionId, string> = {
      birthday: 'birthday gift',
      christmas: 'Christmas holiday gift',
      mothers_day: "Mother's Day gift",
      fathers_day: "Father's Day gift",
      anniversary: 'anniversary gift',
    };

    const topLikes = contact.giftProfile.likes.slice(0, 3).join(', ');
    const topBrands = contact.giftProfile.favoriteBrands.slice(0, 2).join(', ');
    const queryParts = [
      occasionTerms[occasionId],
      `for ${contact.giftProfile.relationship}`,
      topLikes ? `matching (${topLikes})` : '',
      topBrands ? `preferred brands (${topBrands})` : '',
      filterState.searchKeyword.trim()
        ? `keyword "${filterState.searchKeyword.trim()}"`
        : '',
    ].filter(Boolean);

    return {
      merchant:
        filterState.merchantId && filterState.merchantId !== 'all'
          ? { merchantId: filterState.merchantId }
          : undefined,
      query: queryParts.join(' — '),
      filters: this.ucpCatalog.buildUcpSearchFilters(filterState, occasionId),
      context: {
        locale: 'en-US',
        currencyCode: 'USD',
        occasion: occasionId,
        recipientRelationship: contact.giftProfile.relationship,
      },
      signals: {
        userAgent: 'EverydaySanta/1.0 (UCP-2026-08-25; AgenticDiscovery)',
        surface: 'EVERYDAY_SANTA_WEB',
        timestamp: new Date().toISOString(),
      },
      pagination: {
        pageSize: 24,
      },
    };
  }

  /**
   * Executes UCP catalog discovery + AI personalization scoring for a contact & occasion.
   */
  recommendGifts(
    contact: SantaContact,
    occasionId: GiftOccasionId,
    filterState: SecondaryFilterState
  ): {
    request: UcpSearchCatalogRequest;
    recommendations: GiftRecommendation[];
  } {
    const request = this.buildUcpSearchRequest(
      contact,
      occasionId,
      filterState
    );
    const catalogRes = this.ucpCatalog.searchCatalog(request);
    const savedSet = new Set(
      this.savedGifts()
        .filter((s) => s.contactResourceName === contact.resourceName)
        .map((s) => s.productId)
    );

    const profile = contact.giftProfile;
    const dislikesLower = profile.dislikes.map((d) => d.toLowerCase());
    const pastLower = profile.pastGifts.map((p) => p.toLowerCase());

    const recommendations: GiftRecommendation[] = [];

    for (const product of catalogRes.products) {
      const searchableText = [
        product.offer.title,
        product.offer.description,
        product.category,
        product.merchant.merchantName,
        ...product.tags,
      ]
        .join(' ')
        .toLowerCase();

      // Exclude products that strongly collide with contact's explicit dislikes or past gifts
      const hitsDislike = dislikesLower.some((dislike) => {
        const tokens = dislike
          .split(/\s+/)
          .filter((t) => t.length >= 4 && !['strong', 'cheap', 'heavy'].includes(t));
        return tokens.length > 0 && tokens.every((t) => searchableText.includes(t));
      });
      if (hitsDislike) {
        continue;
      }

      const hitsPastGift = pastLower.some(
        (past) =>
          past.length > 4 &&
          product.offer.title.toLowerCase().includes(past.split('(')[0].trim())
      );
      if (hitsPastGift) {
        continue;
      }

      let score = 52;
      const matchedSignals: string[] = [];

      // 1. Match against contact's structured Likes
      for (const like of profile.likes) {
        const likeLower = like.toLowerCase();
        const words = likeLower
          .split(/\s+/)
          .filter((w) => w.length >= 3 && !['and', 'the', 'for'].includes(w));

        const directMatch =
          searchableText.includes(likeLower) ||
          product.tags.some(
            (t) =>
              t.toLowerCase().includes(likeLower) ||
              likeLower.includes(t.toLowerCase())
          );
        const wordMatchCount = words.filter((w) =>
          searchableText.includes(w)
        ).length;

        if (directMatch || (words.length > 0 && wordMatchCount >= Math.ceil(words.length / 2))) {
          score += 18;
          matchedSignals.push(`Likes: ${like}`);
        }
      }

      // 2. Match against freeform note keywords
      const freeformLower = profile.freeformNotes.toLowerCase();
      for (const tag of product.tags) {
        const tagLower = tag.toLowerCase();
        if (
          tagLower.length >= 4 &&
          freeformLower.includes(tagLower) &&
          !matchedSignals.some((s) => s.toLowerCase().includes(tagLower))
        ) {
          score += 9;
          matchedSignals.push(`Note context: "${tag}"`);
        }
      }

      // 3. Match against favorite brands / UCP merchant
      const brandHit = profile.favoriteBrands.find(
        (b) =>
          product.merchant.merchantName
            .toLowerCase()
            .includes(b.toLowerCase()) ||
          searchableText.includes(b.toLowerCase())
      );
      if (brandHit) {
        score += 12;
        matchedSignals.push(`Favorite brand: ${brandHit}`);
      }

      // 4. Match against active occasion (Birthday, Christmas, Mother's Day, Father's Day, Anniversary)
      if (product.bestForOccasions.includes(occasionId)) {
        score += 8;
        const occLabels: Record<GiftOccasionId, string> = {
          birthday: 'Birthday Favorite',
          christmas: 'Christmas Pick',
          mothers_day: "Mother's Day Curated",
          fathers_day: "Father's Day Curated",
          anniversary: 'Anniversary Pick',
        };
        matchedSignals.push(occLabels[occasionId]);
      }

      // 5. Match against relationship (e.g. Mom, Dad, Partner, Sibling)
      if (product.bestForRelationships.includes(profile.relationship)) {
        score += 7;
      }

      // 6. Match against target budget range
      const price = product.offer.price.units;
      if (
        price >= profile.targetBudget.min &&
        price <= profile.targetBudget.max
      ) {
        score += 6;
        matchedSignals.push(
          `In $${profile.targetBudget.min}–$${profile.targetBudget.max} budget`
        );
      }

      const clampedScore = Math.min(99, Math.max(55, score));
      const aiRationale = this.buildAiRationale(
        contact,
        product,
        occasionId,
        matchedSignals
      );

      recommendations.push({
        product,
        matchScore: clampedScore,
        aiRationale,
        matchedSignals: matchedSignals.slice(0, 4),
        occasionFitLabel: this.getOccasionFitBadge(occasionId, contact),
        ucpQueryUsed: request.query,
        savedByUser: savedSet.has(product.productId),
      });
    }

    // Apply secondary SortBy option
    recommendations.sort((a, b) => {
      switch (filterState.sortBy) {
        case 'price_asc':
          return a.product.offer.price.units - b.product.offer.price.units;
        case 'price_desc':
          return b.product.offer.price.units - a.product.offer.price.units;
        case 'fastest_delivery':
          return (
            a.product.offer.shippingAndReturnInfo.maxDeliveryBusinessDays -
            b.product.offer.shippingAndReturnInfo.maxDeliveryBusinessDays
          );
        case 'highest_rated':
          return (
            b.product.rating - a.product.rating ||
            b.product.reviewCount - a.product.reviewCount
          );
        case 'best_match':
        default:
          return (
            b.matchScore - a.matchScore || b.product.rating - a.product.rating
          );
      }
    });

    return { request, recommendations };
  }

  /**
   * Calls Gemini 4 (`gemini-4-carbon` / `gemini-4-argon` / `gemini-4-hydrogen`) directly from the browser
   * if an API key is provided, or synthesizes structured AI gift concepts locally from the contact's synced notes.
   */
  async generateAiGiftBrainstorm(
    contact: SantaContact,
    occasionId: GiftOccasionId,
    geminiApiKey?: string,
    geminiModel: string = 'gemini-4-carbon'
  ): Promise<AiCustomPromptIdea[]> {
    const key = `${contact.resourceName}::${occasionId}`;
    const activeModel = geminiModel.trim() || 'gemini-4-carbon';
    this.isGeneratingGemini.set(true);
    this.aiStatusMessage.set(null);

    try {
      if (geminiApiKey && geminiApiKey.trim()) {
        const prompt = `You are Everyday Santa, an expert AI personal shopper using the Universal Commerce Protocol (UCP).
Suggest 3 hyper-specific gift ideas for ${contact.displayName} (${contact.giftProfile.relationship}) for occasion: ${occasionId}.
Contact's synced Google Contacts Notes: "${contact.giftProfile.freeformNotes}"
Likes: ${contact.giftProfile.likes.join(', ')}
Dislikes (must avoid): ${contact.giftProfile.dislikes.join(', ')}
Sizes: ${contact.giftProfile.sizes || 'N/A'}
Target Budget: $${contact.giftProfile.targetBudget.min}-$${contact.giftProfile.targetBudget.max}
Return JSON array of objects with fields: title, category, estimatedPrice, whyItFits, ucpSearchQuery.`;

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel)}:generateContent?key=${encodeURIComponent(geminiApiKey.trim())}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                responseMimeType: 'application/json',
              },
            }),
          }
        );

        if (res.ok) {
          const data = await res.json();
          const textOut =
            data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
          const parsed: AiCustomPromptIdea[] = JSON.parse(textOut);
          if (Array.isArray(parsed) && parsed.length > 0) {
            this.customAiIdeas.update((prev) => ({ ...prev, [key]: parsed }));
            this.aiStatusMessage.set(
              `Generated ${parsed.length} live ${activeModel} gift concepts for ${contact.givenName}.`
            );
            return parsed;
          }
        }
      }

      // Deterministic local AI synthesis grounded in the contact's current notes
      const localIdeas = this.synthesizeLocalBrainstorm(contact, occasionId);
      this.customAiIdeas.update((prev) => ({ ...prev, [key]: localIdeas }));
      this.aiStatusMessage.set(
        `Synthesized ${localIdeas.length} tailored AI + UCP gift concepts from ${contact.givenName}'s synced contact notes.`
      );
      return localIdeas;
    } finally {
      this.isGeneratingGemini.set(false);
    }
  }

  toggleSaveGift(
    contact: SantaContact,
    occasionId: GiftOccasionId,
    product: UcpDetailProduct
  ): void {
    const current = this.savedGifts();
    const existingIdx = current.findIndex(
      (s) =>
        s.contactResourceName === contact.resourceName &&
        s.productId === product.productId
    );

    let updated: SavedGiftEntry[];
    if (existingIdx >= 0) {
      updated = current.filter((_, i) => i !== existingIdx);
    } else {
      const entry: SavedGiftEntry = {
        id: `saved-${Date.now()}-${product.productId}`,
        contactResourceName: contact.resourceName,
        contactName: contact.displayName,
        occasionId,
        productId: product.productId,
        productTitle: product.offer.title,
        merchantName: product.merchant.merchantName,
        formattedPrice: product.offer.formattedPrice,
        offerUrl: product.offer.offerUrl,
        savedAt: new Date().toISOString(),
        purchased: false,
      };
      updated = [entry, ...current];
    }

    this.savedGifts.set(updated);
    this.persistSavedGifts(updated);
  }

  togglePurchasedStatus(savedId: string): void {
    const updated = this.savedGifts().map((item) =>
      item.id === savedId ? { ...item, purchased: !item.purchased } : item
    );
    this.savedGifts.set(updated);
    this.persistSavedGifts(updated);
  }

  private buildAiRationale(
    contact: SantaContact,
    product: UcpDetailProduct,
    occasionId: GiftOccasionId,
    matchedSignals: string[]
  ): string {
    const occasionPhrase: Record<GiftOccasionId, string> = {
      birthday: `${contact.givenName}'s upcoming birthday`,
      christmas: `Christmas morning for ${contact.givenName}`,
      mothers_day: `Mother's Day for ${contact.givenName}`,
      fathers_day: `Father's Day for ${contact.givenName}`,
      anniversary: `your anniversary with ${contact.givenName}`,
    };

    const likeHighlight =
      matchedSignals.find((s) => s.startsWith('Likes:'))?.replace('Likes: ', '') ||
      contact.giftProfile.likes[0] ||
      'thoughtful craftsmanship';

    const dislikeGuard =
      contact.giftProfile.dislikes.length > 0
        ? ` Avoids "${contact.giftProfile.dislikes[0]}" per synced notes.`
        : '';

    const sizeNote =
      contact.giftProfile.sizes &&
      product.category === 'Apparel & Accessories'
        ? ` Note size on file: ${contact.giftProfile.sizes}.`
        : '';

    return `Tailored for ${occasionPhrase[occasionId]} because ${contact.givenName}'s Google Contact notes highlight "${likeHighlight}".${sizeNote}${dislikeGuard}`;
  }

  private getOccasionFitBadge(
    occasionId: GiftOccasionId,
    contact: SantaContact
  ): string {
    switch (occasionId) {
      case 'birthday':
        return `${contact.givenName}'s Birthday Pick`;
      case 'christmas':
        return 'Christmas & Holiday Favorite';
      case 'mothers_day':
        return "Mother's Day Spotlight";
      case 'fathers_day':
        return "Father's Day Spotlight";
      case 'anniversary':
        return 'Milestone & Anniversary Pick';
    }
  }

  private synthesizeLocalBrainstorm(
    contact: SantaContact,
    occasionId: GiftOccasionId
  ): AiCustomPromptIdea[] {
    const likes =
      contact.giftProfile.likes.length > 0
        ? contact.giftProfile.likes
        : ['Specialty Coffee', 'Cozy Reading', 'Outdoors'];
    const minB = contact.giftProfile.targetBudget.min;
    const maxB = contact.giftProfile.targetBudget.max;

    return likes.slice(0, 3).map((like, idx) => ({
      title: `Bespoke ${like} Upgrade for ${contact.givenName}`,
      category: idx === 0 ? 'Primary Gift' : idx === 1 ? 'Experience / Bundle' : 'Stocking Stuffer',
      estimatedPrice: `$${Math.round(minB + ((maxB - minB) * (idx + 1)) / 3)}`,
      whyItFits: `Directly builds on "${like}" from ${contact.displayName}'s synced Google Contacts biography while steering clear of ${contact.giftProfile.dislikes[0] || 'generic clutter'}.`,
      ucpSearchQuery: `${like} ${occasionId.replace('_', ' ')} gift`,
    }));
  }

  private loadSavedGifts(): SavedGiftEntry[] {
    try {
      const raw = localStorage.getItem(SAVED_GIFTS_STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      // Ignore
    }
    return [];
  }

  private persistSavedGifts(items: SavedGiftEntry[]): void {
    try {
      localStorage.setItem(SAVED_GIFTS_STORAGE_KEY, JSON.stringify(items));
    } catch {
      // Ignore
    }
  }
}
