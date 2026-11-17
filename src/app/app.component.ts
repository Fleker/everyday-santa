import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  ContactRelationship,
  GiftOccasionId,
  GiftRecommendation,
  GiftSortOption,
  OccasionMetadata,
  PricePresetId,
  ProductCategory,
  SantaContact,
  SecondaryFilterState,
  UcpCheckoutPayload,
  UcpDetailProduct,
  UcpMerchantProfile,
} from './models/santa.model';
import {
  AiCustomPromptIdea,
  AiGiftEngineService,
} from './services/ai-gift-engine.service';
import { GoogleContactsService } from './services/google-contacts.service';
import {
  ALL_PRODUCT_CATEGORIES,
  UcpCatalogService,
} from './services/ucp-catalog.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatChipsModule,
    MatIconModule,
    MatTooltipModule,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  readonly contactsService = inject(GoogleContactsService);
  readonly ucpCatalog = inject(UcpCatalogService);
  readonly aiEngine = inject(AiGiftEngineService);

  readonly allCategories = ALL_PRODUCT_CATEGORIES;
  readonly relationships: ContactRelationship[] = [
    'Mom',
    'Dad',
    'Partner',
    'Sibling',
    'Child',
    'Grandparent',
    'Friend',
    'Relative',
    'Colleague',
    'Other',
  ];

  // Active Occasion & Selected Person
  readonly activeOccasionId = signal<GiftOccasionId>('christmas');
  readonly activeContactResourceName = signal<string>('people/c101-linda-mom');
  readonly contactSearchQuery = signal<string>('');

  // Note Studio Mode ('structured' vs 'raw_google_note')
  readonly noteEditorMode = signal<'structured' | 'raw_google_note'>('structured');
  readonly notesPanelExpanded = signal<boolean>(true);
  readonly newLikeInput = signal<string>('');
  readonly newDislikeInput = signal<string>('');
  readonly newBrandInput = signal<string>('');

  // Secondary Product Filters State (maps to UCP SearchFilters)
  readonly filterState = signal<SecondaryFilterState>({
    categories: [],
    pricePreset: 'all',
    minPrice: null,
    maxPrice: null,
    freeShippingOnly: false,
    fastDeliveryOnly: false,
    freeReturnsOnly: false,
    inStockOnly: true,
    oneClickUcpOnly: false,
    merchantId: 'all',
    minRating: 0,
    searchKeyword: '',
    sortBy: 'best_match',
  });

  // Modals & Drawers
  readonly showContactsPickerModal = signal<boolean>(false);
  readonly contactsPickerFilter = signal<'all' | 'has_birthday' | 'has_notes'>('all');
  readonly contactsPickerSearch = signal<string>('');

  readonly showAddContactModal = signal<boolean>(false);
  readonly newContactForm = signal<{
    displayName: string;
    email: string;
    relationship: ContactRelationship;
    birthdayMonth: number;
    birthdayDay: number;
    freeformNotes: string;
    likesCsv: string;
    dislikesCsv: string;
    sizes: string;
  }>({
    displayName: '',
    email: '',
    relationship: 'Friend',
    birthdayMonth: 12,
    birthdayDay: 15,
    freeformNotes: '',
    likesCsv: '',
    dislikesCsv: '',
    sizes: '',
  });

  readonly showOAuthModal = signal<boolean>(false);
  readonly oauthForm = signal<{
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    loginHint: string;
    geminiApiKey: string;
  }>({
    clientId: '',
    clientSecret: '',
    redirectUri: '',
    loginHint: '',
    geminiApiKey: '',
  });

  readonly showUcpInspectorModal = signal<boolean>(false);
  readonly ucpInspectorTab = signal<'search_request' | 'well_known' | 'checkout'>('search_request');
  readonly inspectedMerchant = signal<UcpMerchantProfile | null>(null);
  readonly activeCheckoutPayload = signal<UcpCheckoutPayload | null>(null);
  readonly activeCheckoutProduct = signal<UcpDetailProduct | null>(null);
  readonly checkoutCompletedMessage = signal<string | null>(null);
  readonly newMerchantDomainInput = signal<string>('');
  readonly newMerchantNameInput = signal<string>('');

  readonly showSavedShortlistModal = signal<boolean>(false);

  // Computed Occasion Metadata
  readonly occasions = computed<OccasionMetadata[]>(() =>
    this.contactsService.getOccasionMetadataList()
  );

  readonly activeOccasionMeta = computed<OccasionMetadata>(
    () =>
      this.occasions().find((o) => o.id === this.activeOccasionId()) ||
      this.occasions()[0]
  );

  // Filtered Selected Contacts in Left Sidebar
  readonly sidebarContacts = computed<SantaContact[]>(() => {
    const q = this.contactSearchQuery().trim().toLowerCase();
    const list = this.contactsService.selectedContacts();
    if (!q) return list;
    return list.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        c.giftProfile.relationship.toLowerCase().includes(q) ||
        c.giftProfile.likes.some((l) => l.toLowerCase().includes(q)) ||
        c.giftProfile.freeformNotes.toLowerCase().includes(q)
    );
  });

  // Currently Active Contact
  readonly activeContact = computed<SantaContact | null>(() => {
    const selected = this.contactsService.selectedContacts();
    const target = selected.find(
      (c) => c.resourceName === this.activeContactResourceName()
    );
    return target || selected[0] || this.contactsService.contacts()[0] || null;
  });

  readonly activeContactBirthdayInfo = computed(() => {
    const c = this.activeContact();
    if (!c) return null;
    return this.contactsService.computeDaysUntilBirthday(c.birthday);
  });

  readonly upcomingTimeline = computed(() =>
    this.contactsService.getUpcomingOccasionTimeline().slice(0, 6)
  );

  // Computed UCP Search Request + Personalized Gift Recommendations
  readonly activeDiscoveryResult = computed<{
    request: ReturnType<AiGiftEngineService['buildUcpSearchRequest']>;
    recommendations: GiftRecommendation[];
  }>(() => {
    const contact = this.activeContact();
    const occasion = this.activeOccasionId();
    const filters = this.filterState();
    // Subscribe to savedGifts signal changes so saved badges update reactively
    this.aiEngine.savedGifts();

    if (!contact) {
      return {
        request: {
          query: '',
          filters: { categories: [] },
          context: {
            locale: 'en-US',
            currencyCode: 'USD',
            occasion,
            recipientRelationship: 'Friend',
          },
          signals: {
            userAgent: 'EverydaySanta/1.0',
            surface: 'EVERYDAY_SANTA_WEB',
            timestamp: '',
          },
          pagination: { pageSize: 24 },
        },
        recommendations: [],
      };
    }

    return this.aiEngine.recommendGifts(contact, occasion, filters);
  });

  readonly activeRecommendations = computed<GiftRecommendation[]>(
    () => this.activeDiscoveryResult().recommendations
  );

  readonly activeUcpSearchRequestJson = computed<string>(() =>
    JSON.stringify(this.activeDiscoveryResult().request, null, 2)
  );

  readonly activeWellKnownJson = computed<string>(() => {
    const merchant =
      this.inspectedMerchant() || this.ucpCatalog.merchants()[0];
    return JSON.stringify(
      this.ucpCatalog.buildWellKnownDocument(merchant),
      null,
      2
    );
  });

  readonly activeCheckoutJson = computed<string>(() => {
    const payload = this.activeCheckoutPayload();
    if (!payload) return '{}';
    return JSON.stringify(payload, null, 2);
  });

  readonly activeBrainstormIdeas = computed<AiCustomPromptIdea[]>(() => {
    const contact = this.activeContact();
    if (!contact) return [];
    const key = `${contact.resourceName}::${this.activeOccasionId()}`;
    return this.aiEngine.customAiIdeas()[key] || [];
  });

  readonly activeFilterCount = computed<number>(() => {
    const f = this.filterState();
    let count = 0;
    if (f.categories.length > 0) count += f.categories.length;
    if (f.pricePreset !== 'all' || f.minPrice !== null || f.maxPrice !== null)
      count++;
    if (f.freeShippingOnly) count++;
    if (f.fastDeliveryOnly) count++;
    if (f.freeReturnsOnly) count++;
    if (f.oneClickUcpOnly) count++;
    if (f.merchantId !== 'all') count++;
    if (f.minRating > 0) count++;
    if (f.searchKeyword.trim()) count++;
    return count;
  });

  readonly pickerFilteredContacts = computed<SantaContact[]>(() => {
    const mode = this.contactsPickerFilter();
    const q = this.contactsPickerSearch().trim().toLowerCase();
    return this.contactsService.contacts().filter((c) => {
      if (mode === 'has_birthday' && !c.birthday) return false;
      if (mode === 'has_notes' && !c.giftProfile.freeformNotes.trim())
        return false;
      if (q) {
        const hay = `${c.displayName} ${c.email || ''} ${c.giftProfile.relationship} ${c.giftProfile.freeformNotes}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  async ngOnInit(): Promise<void> {
    const cfg = this.contactsService.oauthConfig();
    this.oauthForm.set({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      redirectUri: cfg.redirectUri,
      loginHint: '',
      geminiApiKey: cfg.geminiApiKey || '',
    });
    this.inspectedMerchant.set(this.ucpCatalog.merchants()[0] || null);

    try {
      await this.contactsService.handleOAuthCallbackIfPresent();
    } catch (err: any) {
      this.contactsService.syncError.set(err?.message || 'OAuth callback error');
    }
  }

  // Occasion & Contact Navigation
  selectOccasion(occasionId: GiftOccasionId): void {
    this.activeOccasionId.set(occasionId);

    // If switching to Mother's Day or Father's Day, auto-select a matching contact if current doesn't match
    const current = this.activeContact();
    if (occasionId === 'mothers_day') {
      if (
        current &&
        current.giftProfile.relationship !== 'Mom' &&
        !current.giftProfile.occasions.includes('mothers_day')
      ) {
        const mom = this.contactsService
          .selectedContacts()
          .find(
            (c) =>
              c.giftProfile.relationship === 'Mom' ||
              c.giftProfile.occasions.includes('mothers_day')
          );
        if (mom) this.activeContactResourceName.set(mom.resourceName);
      }
    } else if (occasionId === 'fathers_day') {
      if (
        current &&
        current.giftProfile.relationship !== 'Dad' &&
        !current.giftProfile.occasions.includes('fathers_day')
      ) {
        const dad = this.contactsService
          .selectedContacts()
          .find(
            (c) =>
              c.giftProfile.relationship === 'Dad' ||
              c.giftProfile.occasions.includes('fathers_day')
          );
        if (dad) this.activeContactResourceName.set(dad.resourceName);
      }
    }
  }

  selectContact(resourceName: string): void {
    this.activeContactResourceName.set(resourceName);
  }

  selectTimelineEvent(resourceName: string, occasionId: GiftOccasionId): void {
    this.activeContactResourceName.set(resourceName);
    this.activeOccasionId.set(occasionId);
  }

  // Bidirectional Note Editing & Sync Actions
  onFreeformNotesChange(newText: string): void {
    const contact = this.activeContact();
    if (!contact) return;
    this.contactsService.updateContactGiftProfile(contact.resourceName, {
      freeformNotes: newText,
    });
  }

  onRawBiographyChange(rawBio: string): void {
    const contact = this.activeContact();
    if (!contact) return;
    this.contactsService.updateContactRawBiography(
      contact.resourceName,
      rawBio
    );
  }

  onRelationshipChange(relationship: ContactRelationship): void {
    const contact = this.activeContact();
    if (!contact) return;
    const occasions = new Set<GiftOccasionId>(contact.giftProfile.occasions);
    if (relationship === 'Mom') occasions.add('mothers_day');
    if (relationship === 'Dad') occasions.add('fathers_day');
    if (relationship === 'Partner') occasions.add('anniversary');

    this.contactsService.updateContactGiftProfile(contact.resourceName, {
      relationship,
      occasions: Array.from(occasions),
    });
  }

  onSizesChange(sizes: string): void {
    const contact = this.activeContact();
    if (!contact) return;
    this.contactsService.updateContactGiftProfile(contact.resourceName, {
      sizes,
    });
  }

  onBudgetChange(min: number, max: number): void {
    const contact = this.activeContact();
    if (!contact) return;
    this.contactsService.updateContactGiftProfile(contact.resourceName, {
      targetBudget: {
        min: Math.max(0, Number(min) || 0),
        max: Math.max(10, Number(max) || 150),
      },
    });
  }

  addLikeTag(): void {
    const contact = this.activeContact();
    const val = this.newLikeInput().trim();
    if (!contact || !val) return;
    if (!contact.giftProfile.likes.includes(val)) {
      this.contactsService.updateContactGiftProfile(contact.resourceName, {
        likes: [...contact.giftProfile.likes, val],
      });
    }
    this.newLikeInput.set('');
  }

  removeLikeTag(tag: string): void {
    const contact = this.activeContact();
    if (!contact) return;
    this.contactsService.updateContactGiftProfile(contact.resourceName, {
      likes: contact.giftProfile.likes.filter((l) => l !== tag),
    });
  }

  addDislikeTag(): void {
    const contact = this.activeContact();
    const val = this.newDislikeInput().trim();
    if (!contact || !val) return;
    if (!contact.giftProfile.dislikes.includes(val)) {
      this.contactsService.updateContactGiftProfile(contact.resourceName, {
        dislikes: [...contact.giftProfile.dislikes, val],
      });
    }
    this.newDislikeInput.set('');
  }

  removeDislikeTag(tag: string): void {
    const contact = this.activeContact();
    if (!contact) return;
    this.contactsService.updateContactGiftProfile(contact.resourceName, {
      dislikes: contact.giftProfile.dislikes.filter((d) => d !== tag),
    });
  }

  addBrandTag(): void {
    const contact = this.activeContact();
    const val = this.newBrandInput().trim();
    if (!contact || !val) return;
    if (!contact.giftProfile.favoriteBrands.includes(val)) {
      this.contactsService.updateContactGiftProfile(contact.resourceName, {
        favoriteBrands: [...contact.giftProfile.favoriteBrands, val],
      });
    }
    this.newBrandInput.set('');
  }

  removeBrandTag(brand: string): void {
    const contact = this.activeContact();
    if (!contact) return;
    this.contactsService.updateContactGiftProfile(contact.resourceName, {
      favoriteBrands: contact.giftProfile.favoriteBrands.filter(
        (b) => b !== brand
      ),
    });
  }

  async pushActiveContactNotes(): Promise<void> {
    const contact = this.activeContact();
    if (!contact) return;
    await this.contactsService.pushContactNotesToGoogle(contact.resourceName);
  }

  async pullActiveContactNotes(): Promise<void> {
    const contact = this.activeContact();
    if (!contact) return;
    await this.contactsService.pullContactNotesFromGoogle(contact.resourceName);
  }

  async syncAllDirtyNotes(): Promise<void> {
    await this.contactsService.syncAllDirtyContacts();
  }

  // Secondary Product Filter Controls (UCP SearchFilters)
  toggleCategoryFilter(category: ProductCategory): void {
    this.filterState.update((prev) => {
      const exists = prev.categories.includes(category);
      const categories = exists
        ? prev.categories.filter((c) => c !== category)
        : [...prev.categories, category];
      return { ...prev, categories };
    });
  }

  clearCategoryFilters(): void {
    this.filterState.update((prev) => ({ ...prev, categories: [] }));
  }

  setPricePreset(preset: PricePresetId): void {
    this.filterState.update((prev) => ({
      ...prev,
      pricePreset: preset,
      minPrice: null,
      maxPrice: null,
    }));
  }

  toggleBooleanFilter(
    field:
      | 'freeShippingOnly'
      | 'fastDeliveryOnly'
      | 'freeReturnsOnly'
      | 'inStockOnly'
      | 'oneClickUcpOnly'
  ): void {
    this.filterState.update((prev) => ({
      ...prev,
      [field]: !prev[field],
    }));
  }

  setMerchantFilter(merchantId: string): void {
    this.filterState.update((prev) => ({ ...prev, merchantId }));
  }

  setMinRatingFilter(minRating: number): void {
    this.filterState.update((prev) => ({ ...prev, minRating }));
  }

  setSortBy(sortBy: GiftSortOption): void {
    this.filterState.update((prev) => ({ ...prev, sortBy }));
  }

  setSearchKeyword(searchKeyword: string): void {
    this.filterState.update((prev) => ({ ...prev, searchKeyword }));
  }

  resetSecondaryFilters(): void {
    this.filterState.set({
      categories: [],
      pricePreset: 'all',
      minPrice: null,
      maxPrice: null,
      freeShippingOnly: false,
      fastDeliveryOnly: false,
      freeReturnsOnly: false,
      inStockOnly: true,
      oneClickUcpOnly: false,
      merchantId: 'all',
      minRating: 0,
      searchKeyword: '',
      sortBy: 'best_match',
    });
  }

  // AI Brainstorm & UCP Actions
  async triggerAiBrainstorm(): Promise<void> {
    const contact = this.activeContact();
    if (!contact) return;
    await this.aiEngine.generateAiGiftBrainstorm(
      contact,
      this.activeOccasionId(),
      this.contactsService.oauthConfig().geminiApiKey
    );
  }

  applyBrainstormQuery(idea: AiCustomPromptIdea): void {
    const firstWord = idea.ucpSearchQuery.split(/\s+/)[0] || '';
    this.setSearchKeyword(firstWord);
  }

  toggleSaveRecommendation(product: UcpDetailProduct): void {
    const contact = this.activeContact();
    if (!contact) return;
    this.aiEngine.toggleSaveGift(contact, this.activeOccasionId(), product);
  }

  openUcpCheckoutModal(product: UcpDetailProduct): void {
    const contact = this.activeContact();
    if (!contact) return;
    const payload = this.ucpCatalog.buildUcpCheckoutPayload(
      product,
      contact,
      this.activeOccasionId()
    );
    this.activeCheckoutProduct.set(product);
    this.activeCheckoutPayload.set(payload);
    this.inspectedMerchant.set(product.merchant);
    this.checkoutCompletedMessage.set(null);
    this.ucpInspectorTab.set('checkout');
    this.showUcpInspectorModal.set(true);
  }

  openUcpSearchInspector(): void {
    this.ucpInspectorTab.set('search_request');
    this.showUcpInspectorModal.set(true);
  }

  openUcpWellKnownInspector(merchant?: UcpMerchantProfile): void {
    if (merchant) {
      this.inspectedMerchant.set(merchant);
    }
    this.ucpInspectorTab.set('well_known');
    this.showUcpInspectorModal.set(true);
  }

  completeSimulatedUcpCheckout(): void {
    const product = this.activeCheckoutProduct();
    const contact = this.activeContact();
    if (!product || !contact) return;

    if (
      !this.aiEngine
        .savedGifts()
        .some(
          (s) =>
            s.contactResourceName === contact.resourceName &&
            s.productId === product.productId
        )
    ) {
      this.aiEngine.toggleSaveGift(contact, this.activeOccasionId(), product);
    }
    this.checkoutCompletedMessage.set(
      `UCP Checkout Mandate signed via com.google.pay for ${product.offer.title} (${product.merchant.domain}). Merchant of Record order confirmed!`
    );
  }

  async registerCustomUcpMerchant(): Promise<void> {
    const domain = this.newMerchantDomainInput().trim();
    if (!domain) return;
    const profile = await this.ucpCatalog.probeAndRegisterMerchantWellKnown(
      domain,
      this.newMerchantNameInput().trim() || undefined
    );
    this.inspectedMerchant.set(profile);
    this.newMerchantDomainInput.set('');
    this.newMerchantNameInput.set('');
  }

  // Contacts Picker & Custom Contact Creation
  patchNewContactForm(
    patch: Partial<{
      displayName: string;
      email: string;
      relationship: ContactRelationship;
      birthdayMonth: number;
      birthdayDay: number;
      freeformNotes: string;
      likesCsv: string;
      dislikesCsv: string;
      sizes: string;
    }>
  ): void {
    this.newContactForm.update((f) => ({ ...f, ...patch }));
  }

  patchOAuthForm(
    patch: Partial<{
      clientId: string;
      clientSecret: string;
      redirectUri: string;
      loginHint: string;
      geminiApiKey: string;
    }>
  ): void {
    this.oauthForm.update((f) => ({ ...f, ...patch }));
  }

  selectInspectedMerchantById(merchantId: string): void {
    const found =
      this.ucpCatalog.merchants().find((m) => m.merchantId === merchantId) ||
      null;
    this.inspectedMerchant.set(found);
  }

  submitAddCustomContact(): void {
    const form = this.newContactForm();
    if (!form.displayName.trim()) return;

    const created = this.contactsService.addCustomContact({
      displayName: form.displayName,
      email: form.email,
      relationship: form.relationship,
      birthdayMonth: Number(form.birthdayMonth) || undefined,
      birthdayDay: Number(form.birthdayDay) || undefined,
      freeformNotes: form.freeformNotes,
      likes: form.likesCsv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      dislikes: form.dislikesCsv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      sizes: form.sizes,
    });

    this.activeContactResourceName.set(created.resourceName);
    this.showAddContactModal.set(false);
    this.newContactForm.set({
      displayName: '',
      email: '',
      relationship: 'Friend',
      birthdayMonth: 12,
      birthdayDay: 15,
      freeformNotes: '',
      likesCsv: '',
      dislikesCsv: '',
      sizes: '',
    });
  }

  // OAuth & Gemini Settings
  saveOAuthAndGeminiSettings(): void {
    const f = this.oauthForm();
    this.contactsService.saveOAuthConfig({
      clientId: f.clientId,
      clientSecret: f.clientSecret,
      redirectUri: f.redirectUri,
      geminiApiKey: f.geminiApiKey,
    });
  }

  startGoogleOAuthFlow(): void {
    this.saveOAuthAndGeminiSettings();
    const f = this.oauthForm();
    if (!f.clientId.trim()) {
      this.contactsService.syncError.set(
        'Enter your Google Cloud OAuth 2.0 Client ID first.'
      );
      return;
    }
    const url = this.contactsService.buildGoogleOAuthUrl(
      f.loginHint.trim() || undefined
    );
    window.location.href = url;
  }

  formatBirthdayBadge(contact: SantaContact): string {
    const info = this.contactsService.computeDaysUntilBirthday(
      contact.birthday
    );
    if (!info) return 'No birthday set';
    if (info.daysUntil === 0) return `🎂 Today! (${info.nextDateLabel})`;
    return `${info.nextDateLabel} (${info.daysUntil}d)`;
  }
}
