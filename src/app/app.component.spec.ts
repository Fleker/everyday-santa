import { TestBed } from '@angular/core/testing';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { AppComponent } from './app.component';
import { AiGiftEngineService } from './services/ai-gift-engine.service';
import { GoogleContactsService } from './services/google-contacts.service';
import { UcpCatalogService } from './services/ucp-catalog.service';

describe('Everyday Santa — AppComponent & Services', () => {
  let contactsService: GoogleContactsService;
  let ucpCatalog: UcpCatalogService;
  let aiEngine: AiGiftEngineService;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideAnimationsAsync()],
    }).compileComponents();

    contactsService = TestBed.inject(GoogleContactsService);
    ucpCatalog = TestBed.inject(UcpCatalogService);
    aiEngine = TestBed.inject(AiGiftEngineService);
  });

  it('should create the app and initialize selected contacts from Google Contacts seed', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    fixture.detectChanges();

    expect(app).toBeTruthy();
    expect(contactsService.contacts().length).toBeGreaterThanOrEqual(8);
    expect(contactsService.selectedContacts().length).toBe(6);
    expect(app.activeContact()?.displayName).toBe('Linda Felker');
  });

  it('should round-trip bidirectional Google Contacts notes (serializeContactNotes <-> parseContactNotes)', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    fixture.detectChanges();

    const mom = app.activeContact()!;
    app.newLikeInput.set('Single-origin Ethiopian beans');
    app.addLikeTag();

    app.newDislikeInput.set('Plastic travel mugs');
    app.addDislikeTag();

    const updatedMom = app.activeContact()!;
    expect(updatedMom.syncStatus).toBe('dirty');
    expect(updatedMom.rawBiography).toContain('[Everyday Santa]');
    expect(updatedMom.rawBiography).toContain('Single-origin Ethiopian beans');
    expect(updatedMom.rawBiography).toContain('Plastic travel mugs');

    // Now simulate editing rawBiography directly (as if edited in Google Contacts mobile app)
    const rawEdited = `Loves winter cabin reading and botanical art.\n---\n[Everyday Santa]\nRelationship: Mom\nOccasions: Birthday, Christmas, Mother's Day\nLikes: Botanical watercolors, Pour-over coffee\nDislikes: Loud gadgets\nSizes: Sweater M\nBudget: $60-$180`;
    app.onRawBiographyChange(rawEdited);

    const reparsed = app.activeContact()!;
    expect(reparsed.giftProfile.freeformNotes).toBe(
      'Loves winter cabin reading and botanical art.'
    );
    expect(reparsed.giftProfile.likes).toContain('Botanical watercolors');
    expect(reparsed.giftProfile.dislikes).toContain('Loud gadgets');
    expect(reparsed.giftProfile.targetBudget).toEqual({ min: 60, max: 180 });
  });

  it('should switch occasions (Birthday, Christmas, Mothers Day, Fathers Day) and auto-focus Mom/Dad', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    fixture.detectChanges();

    // Select Samir (Sibling) first
    app.selectContact('people/c104-samir-brother');
    expect(app.activeContact()?.displayName).toBe('Samir Patel');

    // Switch to Father's Day -> should auto-focus Robert Felker (Dad)
    app.selectOccasion('fathers_day');
    expect(app.activeOccasionId()).toBe('fathers_day');
    expect(app.activeContact()?.giftProfile.relationship).toBe('Dad');
    expect(app.activeContact()?.displayName).toBe('Robert Felker');

    // Switch to Mother's Day -> should auto-focus Linda Felker (Mom)
    app.selectOccasion('mothers_day');
    expect(app.activeOccasionId()).toBe('mothers_day');
    expect(app.activeContact()?.giftProfile.relationship).toBe('Mom');
    expect(app.activeContact()?.displayName).toBe('Linda Felker');
  });

  it('should construct UCP SearchFilters and filter gift recommendations by category, price, and UCP 1-Click', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    fixture.detectChanges();

    const initialCount = app.activeRecommendations().length;
    expect(initialCount).toBeGreaterThan(5);

    // Filter by 'Coffee & Culinary'
    app.toggleCategoryFilter('Coffee & Culinary');
    const coffeeRecs = app.activeRecommendations();
    expect(coffeeRecs.length).toBeGreaterThan(0);
    expect(
      coffeeRecs.every((r) => r.product.category === 'Coffee & Culinary')
    ).toBeTrue();

    // Filter by Price Preset: Under $35
    app.setPricePreset('under_35');
    const under35Recs = app.activeRecommendations();
    expect(under35Recs.length).toBeGreaterThan(0);
    expect(
      under35Recs.every((r) => r.product.offer.price.units <= 35)
    ).toBeTrue();

    // Verify UCP SearchCatalogRequest JSON contains price.max = 35 and categories
    const req = app.activeDiscoveryResult().request;
    expect(req.filters.categories).toEqual(['Coffee & Culinary']);
    expect(req.filters.price?.max?.units).toBe(35);

    // Reset filters
    app.resetSecondaryFilters();
    expect(app.activeRecommendations().length).toBe(initialCount);
  });

  it('should exclude products matching a contact dislike and boost products matching contact likes', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    fixture.detectChanges();

    // Linda loves pour-over coffee -> Fellow Stagg EKG Pro or Carter Mug should be top ranked
    const topRec = app.activeRecommendations()[0];
    expect(topRec.matchScore).toBeGreaterThanOrEqual(80);
    expect(topRec.matchedSignals.length).toBeGreaterThan(0);

    // Add 'sourdough baking' to dislikes and verify the sourdough kit is excluded
    app.newDislikeInput.set('sourdough baking');
    app.addDislikeTag();
    const afterDislike = app.activeRecommendations();
    expect(
      afterDislike.some((r) =>
        r.product.productId.includes('sourdough-challenger-kit')
      )
    ).toBeFalse();
  });

  it('should build valid UCP v2026-08-25 /.well-known/ucp discovery documents and CreateCheckout payloads', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    fixture.detectChanges();

    const merchant = ucpCatalog.merchants()[0];
    const wellKnown = ucpCatalog.buildWellKnownDocument(merchant) as any;
    expect(wellKnown.ucp.version).toBe('2026-08-25');
    expect(
      wellKnown.ucp.capabilities['dev.ucp.shopping.catalog.search']
    ).toBeDefined();
    expect(
      wellKnown.ucp.capabilities['dev.ucp.shopping.checkout']
    ).toBeDefined();

    const firstProduct = app.activeRecommendations()[0].product;
    app.openUcpCheckoutModal(firstProduct);

    const payload = app.activeCheckoutPayload()!;
    expect(payload.ucp.capability).toBe('dev.ucp.shopping.checkout');
    expect(payload.buyer_context.is_gift).toBeTrue();
    expect(payload.buyer_context.gift_recipient_name).toBe('Linda Felker');
    expect(payload.line_items[0].product_id).toBe(firstProduct.productId);
  });

  it('should select/deselect contacts for the Gift Circle and push/pull notes in demo mode', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    fixture.detectChanges();

    // Toggle Jordan Vance into Gift Circle
    contactsService.toggleContactSelection('people/c107-jordan-colleague', true);
    expect(contactsService.selectedContacts().length).toBe(7);

    // Push notes for active contact
    app.onFreeformNotesChange('Updated note for Mom with new pottery interest.');
    expect(app.activeContact()?.syncStatus).toBe('dirty');

    await app.pushActiveContactNotes();
    expect(app.activeContact()?.syncStatus).toBe('demo_local');
    expect(app.activeContact()?.rawBiography).toContain(
      'Updated note for Mom with new pottery interest.'
    );
  });
});
