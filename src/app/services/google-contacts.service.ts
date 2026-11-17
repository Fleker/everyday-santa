import { Injectable, computed, signal } from '@angular/core';
import {
  BirthdayDate,
  ConnectedGoogleAccount,
  ContactRelationship,
  GiftOccasionId,
  GoogleOAuthConfig,
  OccasionMetadata,
  SantaContact,
  StructuredGiftProfile,
  UpcomingOccasionEvent,
} from '../models/santa.model';

const CONTACTS_STORAGE_KEY = 'everyday_santa_contacts_v1';
const OAUTH_CONFIG_STORAGE_KEY = 'everyday_santa_oauth_config_v1';
const GOOGLE_ACCOUNTS_STORAGE_KEY = 'everyday_santa_google_accounts_v1';

const AVATAR_PALETTE = [
  '#b91c1c',
  '#15803d',
  '#1d4ed8',
  '#b45309',
  '#0f766e',
  '#be123c',
  '#4338ca',
  '#a21caf',
];

const SANTA_BLOCK_HEADER = '[Everyday Santa]';

@Injectable({
  providedIn: 'root',
})
export class GoogleContactsService {
  readonly oauthConfig = signal<GoogleOAuthConfig>(this.loadOAuthConfig());
  readonly accounts = signal<ConnectedGoogleAccount[]>(this.loadAccounts());
  readonly contacts = signal<SantaContact[]>(this.loadContacts());
  readonly isSyncing = signal<boolean>(false);
  readonly lastSyncMessage = signal<string | null>(null);
  readonly syncError = signal<string | null>(null);

  /** Only contacts selected by the user for their active Gift Circle */
  readonly selectedContacts = computed<SantaContact[]>(() =>
    this.contacts().filter((c) => c.selectedForSanta)
  );

  /** Count of contacts with local unsynced note edits */
  readonly dirtyContactsCount = computed<number>(
    () => this.contacts().filter((c) => c.syncStatus === 'dirty').length
  );

  saveOAuthConfig(config: GoogleOAuthConfig): void {
    const defaultRedirect =
      typeof window !== 'undefined'
        ? window.location.origin + window.location.pathname
        : 'http://localhost:4206/';
    const normalized: GoogleOAuthConfig = {
      clientId: config.clientId.trim(),
      clientSecret: config.clientSecret.trim(),
      redirectUri: config.redirectUri.trim() || defaultRedirect,
      geminiApiKey: config.geminiApiKey?.trim() || '',
    };
    this.oauthConfig.set(normalized);
    try {
      localStorage.setItem(
        OAUTH_CONFIG_STORAGE_KEY,
        JSON.stringify(normalized)
      );
    } catch {
      // Ignore storage error
    }
  }

  buildGoogleOAuthUrl(loginHint?: string): string {
    const cfg = this.oauthConfig();
    const defaultRedirect =
      typeof window !== 'undefined'
        ? window.location.origin + window.location.pathname
        : 'http://localhost:4206/';
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri || defaultRedirect,
      response_type: 'code',
      // Full contacts read/write scope required for bidirectional biography/notes sync
      scope:
        'https://www.googleapis.com/auth/contacts https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });
    if (loginHint) {
      params.set('login_hint', loginHint);
    }
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async handleOAuthCallbackIfPresent(): Promise<ConnectedGoogleAccount | null> {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return null;

    window.history.replaceState({}, document.title, window.location.pathname);
    const account = await this.exchangeCodeForAccount(code);
    await this.syncContactsFromGoogle(account.email);
    return account;
  }

  async exchangeCodeForAccount(code: string): Promise<ConnectedGoogleAccount> {
    const cfg = this.oauthConfig();
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new Error(
        'Configure your Google OAuth Client ID and Client Secret first.'
      );
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri:
          cfg.redirectUri || window.location.origin + window.location.pathname,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`Google OAuth token exchange failed: ${errText}`);
    }

    const tokenJson = await tokenRes.json();
    const accessToken: string = tokenJson.access_token;
    const refreshToken: string = tokenJson.refresh_token || '';
    const expiresIn: number = tokenJson.expires_in || 3600;

    const profileRes = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const profileJson = profileRes.ok
      ? await profileRes.json()
      : { email: 'connected.user@gmail.com', name: 'Google Account' };

    const existingIdx = this.accounts().findIndex(
      (a) => a.email === profileJson.email
    );
    const color =
      AVATAR_PALETTE[
        (existingIdx >= 0 ? existingIdx : this.accounts().length) %
          AVATAR_PALETTE.length
      ];

    const account: ConnectedGoogleAccount = {
      email: profileJson.email,
      displayName: profileJson.name || profileJson.email,
      accessToken,
      refreshToken:
        refreshToken ||
        (existingIdx >= 0 ? this.accounts()[existingIdx].refreshToken : ''),
      expiresAt: Date.now() + expiresIn * 1000,
      color,
      lastSyncAt: new Date().toISOString(),
    };

    const updated = [...this.accounts()];
    if (existingIdx >= 0) {
      updated[existingIdx] = account;
    } else {
      updated.push(account);
    }
    this.accounts.set(updated);
    this.persistAccounts(updated);
    return account;
  }

  async ensureValidAccessToken(
    account: ConnectedGoogleAccount
  ): Promise<string> {
    if (account.accessToken && Date.now() < account.expiresAt - 60_000) {
      return account.accessToken;
    }
    const cfg = this.oauthConfig();
    if (!account.refreshToken || !cfg.clientId || !cfg.clientSecret) {
      return account.accessToken;
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: account.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to refresh OAuth token for ${account.email}`);
    }
    const data = await res.json();
    const refreshed: ConnectedGoogleAccount = {
      ...account,
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };
    const updated = this.accounts().map((a) =>
      a.email === account.email ? refreshed : a
    );
    this.accounts.set(updated);
    this.persistAccounts(updated);
    return refreshed.accessToken;
  }

  /**
   * Pulls contacts from Google People API v1 (`people.connections.list`),
   * extracting names, birthdays, relations, and notes (`biographies`).
   */
  async syncContactsFromGoogle(accountEmail?: string): Promise<number> {
    const targetAccounts = accountEmail
      ? this.accounts().filter((a) => a.email === accountEmail)
      : this.accounts();

    if (targetAccounts.length === 0) {
      this.lastSyncMessage.set(
        'Demo mode active: syncing against local browser storage. Connect Google OAuth to sync live Google Contacts.'
      );
      return 0;
    }

    this.isSyncing.set(true);
    this.syncError.set(null);
    let importedCount = 0;

    try {
      const existingByResource = new Map<string, SantaContact>(
        this.contacts().map((c) => [c.resourceName, c])
      );

      for (const account of targetAccounts) {
        const token = await this.ensureValidAccessToken(account);
        const url =
          'https://people.googleapis.com/v1/people/me/connections' +
          '?personFields=names,emailAddresses,photos,birthdays,biographies,relations,userDefined,metadata' +
          '&pageSize=1000&sortOrder=FIRST_NAME_ASCENDING';

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(
            `Google People API people.connections.list failed (${res.status}): ${errText}`
          );
        }

        const data = await res.json();
        const connections: any[] = data.connections || [];

        for (let i = 0; i < connections.length; i++) {
          const person = connections[i];
          const parsed = this.mapGooglePersonToSantaContact(
            person,
            account.email,
            i,
            existingByResource.get(person.resourceName)
          );
          if (parsed) {
            existingByResource.set(parsed.resourceName, parsed);
            importedCount++;
          }
        }
      }

      const merged = Array.from(existingByResource.values());
      this.contacts.set(merged);
      this.persistContacts(merged);
      this.lastSyncMessage.set(
        `Synced ${importedCount} contacts from Google People API (${new Date().toLocaleTimeString()}).`
      );
      return importedCount;
    } catch (err: any) {
      const msg = err?.message || 'Failed to sync Google Contacts';
      this.syncError.set(msg);
      throw err;
    } finally {
      this.isSyncing.set(false);
    }
  }

  /**
   * Bidirectional Sync (PULL): Fetches the latest contact record from Google People API
   * (`GET /v1/{resourceName}`) to pull any note edits made in Google Contacts on mobile/web.
   */
  async pullContactNotesFromGoogle(resourceName: string): Promise<SantaContact> {
    const contact = this.contacts().find(
      (c) => c.resourceName === resourceName
    );
    if (!contact) {
      throw new Error(`Contact ${resourceName} not found`);
    }

    const account = this.accounts().find(
      (a) => a.email === contact.accountEmail
    );
    if (!account) {
      // Demo / local contact: simulate clean pull confirmation
      const refreshed: SantaContact = {
        ...contact,
        rawBiography: this.serializeContactNotes(contact.giftProfile),
        syncStatus: 'demo_local',
        lastSyncedAt: new Date().toISOString(),
      };
      this.replaceContact(refreshed);
      this.lastSyncMessage.set(
        `Verified local note snapshot for ${contact.displayName}.`
      );
      return refreshed;
    }

    this.updateContactSyncStatus(resourceName, 'syncing');
    try {
      const token = await this.ensureValidAccessToken(account);
      const url = `https://people.googleapis.com/v1/${resourceName}?personFields=names,emailAddresses,photos,birthdays,biographies,relations,userDefined,metadata`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`People API GET failed (${res.status}): ${errText}`);
      }

      const person = await res.json();
      const updated = this.mapGooglePersonToSantaContact(
        person,
        account.email,
        0,
        contact
      )!;
      updated.syncStatus = 'synced';
      updated.lastSyncedAt = new Date().toISOString();
      this.replaceContact(updated);
      this.lastSyncMessage.set(
        `Pulled latest notes & birthday for ${updated.displayName} from Google Contacts.`
      );
      return updated;
    } catch (err: any) {
      this.updateContactSyncStatus(resourceName, 'error', err?.message);
      throw err;
    }
  }

  /**
   * Bidirectional Sync (PUSH): Writes the updated notes (`biographies`) back to
   * Google Contacts via `PATCH https://people.googleapis.com/v1/{resourceName}:updateContact`.
   * Automatically resolves `etag` conflicts by pulling the latest `etag` and retrying once.
   */
  async pushContactNotesToGoogle(resourceName: string): Promise<SantaContact> {
    const contact = this.contacts().find(
      (c) => c.resourceName === resourceName
    );
    if (!contact) {
      throw new Error(`Contact ${resourceName} not found`);
    }

    const serializedBio = this.serializeContactNotes(contact.giftProfile);
    const account = this.accounts().find(
      (a) => a.email === contact.accountEmail
    );

    if (!account) {
      // Demo mode: persist serialized biography in local storage and mark synced locally
      const updatedLocal: SantaContact = {
        ...contact,
        rawBiography: serializedBio,
        syncStatus: 'demo_local',
        lastSyncedAt: new Date().toISOString(),
        syncError: undefined,
      };
      this.replaceContact(updatedLocal);
      this.lastSyncMessage.set(
        `Saved bidirectional note structure for ${contact.displayName} (connect Google OAuth to push to people.googleapis.com).`
      );
      return updatedLocal;
    }

    this.updateContactSyncStatus(resourceName, 'syncing');

    try {
      const token = await this.ensureValidAccessToken(account);
      let currentEtag = contact.etag;

      const attemptPatch = async (etagToUse: string): Promise<Response> => {
        const url =
          `https://people.googleapis.com/v1/${resourceName}:updateContact` +
          `?updatePersonFields=biographies` +
          `&personFields=names,emailAddresses,photos,birthdays,biographies,relations,userDefined,metadata`;
        return fetch(url, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            etag: etagToUse,
            biographies: [
              {
                value: serializedBio,
                contentType: 'TEXT_PLAIN',
              },
            ],
          }),
        });
      };

      let patchRes = await attemptPatch(currentEtag);

      // If etag is stale (HTTP 400 / 409 / 412), fetch latest etag and retry once
      if (
        !patchRes.ok &&
        (patchRes.status === 400 ||
          patchRes.status === 409 ||
          patchRes.status === 412)
      ) {
        const getUrl = `https://people.googleapis.com/v1/${resourceName}?personFields=metadata`;
        const getRes = await fetch(getUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (getRes.ok) {
          const freshPerson = await getRes.json();
          if (freshPerson.etag) {
            currentEtag = freshPerson.etag;
            patchRes = await attemptPatch(currentEtag);
          }
        }
      }

      if (!patchRes.ok) {
        const errText = await patchRes.text();
        throw new Error(
          `People API updateContact failed (${patchRes.status}): ${errText}`
        );
      }

      const updatedPerson = await patchRes.json();
      const syncedContact: SantaContact = {
        ...contact,
        etag: updatedPerson.etag || currentEtag,
        rawBiography: serializedBio,
        syncStatus: 'synced',
        lastSyncedAt: new Date().toISOString(),
        syncError: undefined,
      };
      this.replaceContact(syncedContact);
      this.lastSyncMessage.set(
        `Synced notes for ${contact.displayName} to Google Contacts.`
      );
      return syncedContact;
    } catch (err: any) {
      this.updateContactSyncStatus(resourceName, 'error', err?.message);
      throw err;
    }
  }

  async syncAllDirtyContacts(): Promise<number> {
    const dirty = this.contacts().filter((c) => c.syncStatus === 'dirty');
    let count = 0;
    for (const c of dirty) {
      await this.pushContactNotesToGoogle(c.resourceName);
      count++;
    }
    return count;
  }

  /**
   * Updates a contact's structured gift profile or freeform notes in the app
   * and marks `syncStatus: 'dirty'` so the user can push or auto-sync to Google Contacts.
   */
  updateContactGiftProfile(
    resourceName: string,
    patch: Partial<StructuredGiftProfile>
  ): SantaContact | null {
    const existing = this.contacts().find(
      (c) => c.resourceName === resourceName
    );
    if (!existing) return null;

    const updatedProfile: StructuredGiftProfile = {
      ...existing.giftProfile,
      ...patch,
    };
    const serialized = this.serializeContactNotes(updatedProfile);
    const updatedContact: SantaContact = {
      ...existing,
      giftProfile: updatedProfile,
      rawBiography: serialized,
      syncStatus: 'dirty',
    };
    this.replaceContact(updatedContact);
    return updatedContact;
  }

  /**
   * Allows editing the raw Google Contacts note text directly and re-parses the
   * structured gift profile from it (verifying true two-way note editing).
   */
  updateContactRawBiography(
    resourceName: string,
    rawBiography: string
  ): SantaContact | null {
    const existing = this.contacts().find(
      (c) => c.resourceName === resourceName
    );
    if (!existing) return null;

    const parsedProfile = this.parseContactNotes(
      rawBiography,
      existing.birthday,
      existing.giftProfile.relationship
    );
    const updatedContact: SantaContact = {
      ...existing,
      rawBiography,
      giftProfile: parsedProfile,
      syncStatus: 'dirty',
    };
    this.replaceContact(updatedContact);
    return updatedContact;
  }

  updateContactBirthday(
    resourceName: string,
    birthday: BirthdayDate | undefined
  ): void {
    const existing = this.contacts().find(
      (c) => c.resourceName === resourceName
    );
    if (!existing) return;

    const occasions = new Set<GiftOccasionId>(existing.giftProfile.occasions);
    if (birthday) {
      occasions.add('birthday');
    }
    const updatedContact: SantaContact = {
      ...existing,
      birthday,
      giftProfile: {
        ...existing.giftProfile,
        occasions: Array.from(occasions),
      },
      syncStatus: 'dirty',
    };
    this.replaceContact(updatedContact);
  }

  toggleContactSelection(resourceName: string, selected?: boolean): void {
    const updated = this.contacts().map((c) => {
      if (c.resourceName !== resourceName) return c;
      return {
        ...c,
        selectedForSanta:
          selected !== undefined ? selected : !c.selectedForSanta,
      };
    });
    this.contacts.set(updated);
    this.persistContacts(updated);
  }

  addCustomContact(input: {
    displayName: string;
    email?: string;
    relationship: ContactRelationship;
    birthdayMonth?: number;
    birthdayDay?: number;
    birthdayYear?: number;
    freeformNotes: string;
    likes: string[];
    dislikes: string[];
    sizes?: string;
  }): SantaContact {
    const parts = input.displayName.trim().split(/\s+/);
    const givenName = parts[0] || input.displayName;
    const familyName = parts.slice(1).join(' ');
    const initials = (
      (givenName[0] || '') + (familyName[0] || givenName[1] || '')
    ).toUpperCase();

    const birthday: BirthdayDate | undefined =
      input.birthdayMonth && input.birthdayDay
        ? {
            month: input.birthdayMonth,
            day: input.birthdayDay,
            year: input.birthdayYear,
          }
        : undefined;

    const occasions = this.inferOccasionsForRelationship(
      input.relationship,
      Boolean(birthday)
    );

    const giftProfile: StructuredGiftProfile = {
      freeformNotes: input.freeformNotes.trim(),
      relationship: input.relationship,
      occasions,
      likes: input.likes,
      dislikes: input.dislikes,
      sizes: input.sizes?.trim() || '',
      favoriteBrands: [],
      targetBudget: { min: 35, max: 150 },
      pastGifts: [],
    };

    const rawBiography = this.serializeContactNotes(giftProfile);
    const newContact: SantaContact = {
      resourceName: `people/custom-${Date.now()}`,
      etag: `"etag-${Date.now()}"`,
      accountEmail: this.accounts()[0]?.email || 'demo@contacts.google.com',
      displayName: input.displayName.trim(),
      givenName,
      familyName,
      email: input.email?.trim() || undefined,
      initials,
      avatarColor:
        AVATAR_PALETTE[this.contacts().length % AVATAR_PALETTE.length],
      birthday,
      rawBiography,
      giftProfile,
      selectedForSanta: true,
      syncStatus: 'demo_local',
      lastSyncedAt: new Date().toISOString(),
    };

    const updated = [newContact, ...this.contacts()];
    this.contacts.set(updated);
    this.persistContacts(updated);
    return newContact;
  }

  resetDemoContacts(): void {
    const defaults = this.getDefaultDemoContacts();
    this.contacts.set(defaults);
    this.persistContacts(defaults);
    this.lastSyncMessage.set('Restored default Google Contacts demo dataset.');
  }

  /**
   * Parses a Google Contacts note (`biographies[0].value`) into both freeform notes
   * and a structured `StructuredGiftProfile`.
   * Supports both explicit `[Everyday Santa]` blocks and natural freeform notes.
   */
  parseContactNotes(
    rawBiography: string,
    birthday?: BirthdayDate,
    fallbackRelationship: ContactRelationship = 'Friend'
  ): StructuredGiftProfile {
    const text = (rawBiography || '').replace(/\r\n/g, '\n').trim();
    const blockIdx = text.indexOf(SANTA_BLOCK_HEADER);

    let freeformNotes = text;
    let blockText = '';

    if (blockIdx >= 0) {
      freeformNotes = text
        .slice(0, blockIdx)
        .replace(/\n*---\s*$/, '')
        .trim();
      blockText = text.slice(blockIdx + SANTA_BLOCK_HEADER.length).trim();
    }

    let relationship: ContactRelationship = fallbackRelationship;
    const likes = new Set<string>();
    const dislikes = new Set<string>();
    const favoriteBrands = new Set<string>();
    const pastGifts = new Set<string>();
    const occasions = new Set<GiftOccasionId>();
    let sizes = '';
    let budgetMin = 35;
    let budgetMax = 150;

    const parseCsvInto = (val: string, target: Set<string>) => {
      val
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((item) => target.add(item));
    };

    const linesToScan = blockText
      ? blockText.split('\n')
      : freeformNotes.split('\n');

    for (const rawLine of linesToScan) {
      const line = rawLine.replace(/^[-*]\s*/, '').trim();
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;

      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      if (!value) continue;

      if (key === 'relationship' || key === 'relation' || key === 'role') {
        relationship = this.normalizeRelationship(value);
      } else if (key === 'likes' || key === 'interests' || key === 'loves') {
        parseCsvInto(value, likes);
      } else if (key === 'dislikes' || key === 'avoid' || key === 'allergies') {
        parseCsvInto(value, dislikes);
      } else if (key === 'sizes' || key === 'size') {
        sizes = value;
      } else if (key === 'brands' || key === 'favorite brands') {
        parseCsvInto(value, favoriteBrands);
      } else if (key === 'past gifts' || key === 'previous gifts') {
        parseCsvInto(value, pastGifts);
      } else if (key === 'occasions') {
        const lower = value.toLowerCase();
        if (lower.includes('birthday')) occasions.add('birthday');
        if (lower.includes('christmas') || lower.includes('holiday'))
          occasions.add('christmas');
        if (lower.includes('mother')) occasions.add('mothers_day');
        if (lower.includes('father')) occasions.add('fathers_day');
        if (lower.includes('anniversary') || lower.includes('valentine'))
          occasions.add('anniversary');
      } else if (key === 'budget') {
        const nums = value.match(/\d+/g);
        if (nums && nums.length >= 2) {
          budgetMin = Number(nums[0]);
          budgetMax = Number(nums[1]);
        } else if (nums && nums.length === 1) {
          budgetMax = Number(nums[0]);
        }
      }
    }

    // Also extract natural-language phrases from freeformNotes if likes are still empty
    if (likes.size === 0 && freeformNotes) {
      const lovesMatch = freeformNotes.match(
        /(?:loves|likes|into|enjoys|fan of|obsessed with)\s+([^.!?\n]+)/gi
      );
      if (lovesMatch) {
        for (const m of lovesMatch) {
          const cleaned = m.replace(
            /^(?:loves|likes|into|enjoys|fan of|obsessed with)\s+/i,
            ''
          );
          cleaned
            .split(/,|and\b/i)
            .map((s) => s.trim())
            .filter((s) => s.length > 2 && s.length < 48)
            .forEach((s) => likes.add(s));
        }
      }
    }

    const inferredOccasions = this.inferOccasionsForRelationship(
      relationship,
      Boolean(birthday)
    );
    inferredOccasions.forEach((occ) => occasions.add(occ));

    return {
      freeformNotes,
      relationship,
      occasions: Array.from(occasions),
      likes: Array.from(likes),
      dislikes: Array.from(dislikes),
      sizes,
      favoriteBrands: Array.from(favoriteBrands),
      targetBudget: { min: budgetMin, max: budgetMax },
      pastGifts: Array.from(pastGifts),
    };
  }

  /**
   * Serializes a `StructuredGiftProfile` back into a clean, human-readable string
   * stored inside Google Contacts' `biographies[0].value` field.
   */
  serializeContactNotes(profile: StructuredGiftProfile): string {
    const occasionNames: Record<GiftOccasionId, string> = {
      birthday: 'Birthday',
      christmas: 'Christmas',
      mothers_day: "Mother's Day",
      fathers_day: "Father's Day",
      anniversary: 'Anniversary',
    };

    const metaLines: string[] = [
      SANTA_BLOCK_HEADER,
      `Relationship: ${profile.relationship}`,
      `Occasions: ${profile.occasions.map((o) => occasionNames[o] || o).join(', ')}`,
    ];

    if (profile.likes.length > 0) {
      metaLines.push(`Likes: ${profile.likes.join(', ')}`);
    }
    if (profile.dislikes.length > 0) {
      metaLines.push(`Dislikes: ${profile.dislikes.join(', ')}`);
    }
    if (profile.sizes.trim()) {
      metaLines.push(`Sizes: ${profile.sizes.trim()}`);
    }
    if (profile.favoriteBrands.length > 0) {
      metaLines.push(`Brands: ${profile.favoriteBrands.join(', ')}`);
    }
    metaLines.push(
      `Budget: $${profile.targetBudget.min}-$${profile.targetBudget.max}`
    );
    if (profile.pastGifts.length > 0) {
      metaLines.push(`Past Gifts: ${profile.pastGifts.join(', ')}`);
    }

    const cleanFreeform = profile.freeformNotes.trim();
    if (!cleanFreeform) {
      return metaLines.join('\n');
    }
    return `${cleanFreeform}\n---\n${metaLines.join('\n')}`;
  }

  /**
   * Calculates days until a contact's next birthday relative to `referenceDate`.
   */
  computeDaysUntilBirthday(
    birthday?: BirthdayDate,
    referenceDate: Date = new Date()
  ): { daysUntil: number; nextDateLabel: string; turningAge?: number } | null {
    if (!birthday || !birthday.month || !birthday.day) return null;

    const today = new Date(
      referenceDate.getFullYear(),
      referenceDate.getMonth(),
      referenceDate.getDate()
    );
    let nextBday = new Date(
      today.getFullYear(),
      birthday.month - 1,
      birthday.day
    );
    if (nextBday < today) {
      nextBday = new Date(
        today.getFullYear() + 1,
        birthday.month - 1,
        birthday.day
      );
    }

    const diffMs = nextBday.getTime() - today.getTime();
    const daysUntil = Math.round(diffMs / (1000 * 60 * 60 * 24));
    const monthShort = nextBday.toLocaleDateString('en-US', { month: 'short' });
    const nextDateLabel = `${monthShort} ${birthday.day}`;
    const turningAge = birthday.year
      ? nextBday.getFullYear() - birthday.year
      : undefined;

    return { daysUntil, nextDateLabel, turningAge };
  }

  /**
   * Computes holiday countdowns for Christmas (Dec 25), Mother's Day (2nd Sunday in May),
   * Father's Day (3rd Sunday in June), and Anniversary/Valentine's (Feb 14).
   */
  getOccasionMetadataList(
    referenceDate: Date = new Date()
  ): OccasionMetadata[] {
    const today = new Date(
      referenceDate.getFullYear(),
      referenceDate.getMonth(),
      referenceDate.getDate()
    );

    const daysTo = (target: Date): number =>
      Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    // Christmas: Dec 25
    let christmas = new Date(today.getFullYear(), 11, 25);
    if (christmas < today) {
      christmas = new Date(today.getFullYear() + 1, 11, 25);
    }

    // Mother's Day: 2nd Sunday in May
    let mothersDay = this.getNthSundayOfMonth(today.getFullYear(), 4, 2);
    if (mothersDay < today) {
      mothersDay = this.getNthSundayOfMonth(today.getFullYear() + 1, 4, 2);
    }

    // Father's Day: 3rd Sunday in June
    let fathersDay = this.getNthSundayOfMonth(today.getFullYear(), 5, 3);
    if (fathersDay < today) {
      fathersDay = this.getNthSundayOfMonth(today.getFullYear() + 1, 5, 3);
    }

    // Valentine's / Anniversary default: Feb 14
    let anniversary = new Date(today.getFullYear(), 1, 14);
    if (anniversary < today) {
      anniversary = new Date(today.getFullYear() + 1, 1, 14);
    }

    return [
      {
        id: 'birthday',
        label: 'Birthdays',
        shortLabel: 'Birthday',
        icon: 'cake',
        accentColor: '#d97706',
        badgeBg: '#fef3c7',
        description:
          'Personal birthday gift discovery grounded in Google Contacts birthdays & synced notes.',
        nextDateIso: today.toISOString().slice(0, 10),
        daysUntil: 0,
      },
      {
        id: 'christmas',
        label: 'Christmas & Winter Holidays',
        shortLabel: 'Christmas',
        icon: 'park',
        accentColor: '#b91c1c',
        badgeBg: '#fee2e2',
        description:
          'Dec 25 holiday gifting — cozy main gifts, family favorites, and stocking stuffers.',
        nextDateIso: christmas.toISOString().slice(0, 10),
        daysUntil: daysTo(christmas),
      },
      {
        id: 'mothers_day',
        label: "Mother's Day",
        shortLabel: "Mother's Day",
        icon: 'local_florist',
        accentColor: '#be185d',
        badgeBg: '#fce7f3',
        description:
          "2nd Sunday in May — thoughtful gifts curated for Mom, grandmothers, and maternal figures.",
        nextDateIso: mothersDay.toISOString().slice(0, 10),
        daysUntil: daysTo(mothersDay),
      },
      {
        id: 'fathers_day',
        label: "Father's Day",
        shortLabel: "Father's Day",
        icon: 'handyman',
        accentColor: '#1d4ed8',
        badgeBg: '#dbeafe',
        description:
          "3rd Sunday in June — tailored gear, culinary upgrades, and books for Dad and father figures.",
        nextDateIso: fathersDay.toISOString().slice(0, 10),
        daysUntil: daysTo(fathersDay),
      },
      {
        id: 'anniversary',
        label: 'Anniversary & Valentine',
        shortLabel: 'Anniversary',
        icon: 'favorite',
        accentColor: '#9f1239',
        badgeBg: '#ffe4e6',
        description:
          'Milestone & romantic gifts for your partner or spouse.',
        nextDateIso: anniversary.toISOString().slice(0, 10),
        daysUntil: daysTo(anniversary),
      },
    ];
  }

  /**
   * Builds a chronological list of upcoming birthdays & holidays across all selected contacts.
   */
  getUpcomingOccasionTimeline(
    referenceDate: Date = new Date()
  ): UpcomingOccasionEvent[] {
    const events: UpcomingOccasionEvent[] = [];
    const occasionMeta = this.getOccasionMetadataList(referenceDate);
    const christmasMeta = occasionMeta.find((o) => o.id === 'christmas')!;
    const mothersMeta = occasionMeta.find((o) => o.id === 'mothers_day')!;
    const fathersMeta = occasionMeta.find((o) => o.id === 'fathers_day')!;

    for (const contact of this.selectedContacts()) {
      const bdayInfo = this.computeDaysUntilBirthday(
        contact.birthday,
        referenceDate
      );
      if (bdayInfo) {
        events.push({
          contact,
          occasionId: 'birthday',
          occasionLabel: `${contact.givenName}'s Birthday`,
          dateLabel: bdayInfo.nextDateLabel,
          daysUntil: bdayInfo.daysUntil,
          turningAge: bdayInfo.turningAge,
          icon: 'cake',
          accentColor: '#d97706',
        });
      }

      if (contact.giftProfile.occasions.includes('christmas')) {
        events.push({
          contact,
          occasionId: 'christmas',
          occasionLabel: `Christmas (${contact.givenName})`,
          dateLabel: 'Dec 25',
          daysUntil: christmasMeta.daysUntil,
          icon: 'park',
          accentColor: '#b91c1c',
        });
      }

      if (
        contact.giftProfile.occasions.includes('mothers_day') ||
        contact.giftProfile.relationship === 'Mom'
      ) {
        events.push({
          contact,
          occasionId: 'mothers_day',
          occasionLabel: `Mother's Day (${contact.givenName})`,
          dateLabel: new Date(mothersMeta.nextDateIso + 'T12:00:00').toLocaleDateString(
            'en-US',
            { month: 'short', day: 'numeric' }
          ),
          daysUntil: mothersMeta.daysUntil,
          icon: 'local_florist',
          accentColor: '#be185d',
        });
      }

      if (
        contact.giftProfile.occasions.includes('fathers_day') ||
        contact.giftProfile.relationship === 'Dad'
      ) {
        events.push({
          contact,
          occasionId: 'fathers_day',
          occasionLabel: `Father's Day (${contact.givenName})`,
          dateLabel: new Date(fathersMeta.nextDateIso + 'T12:00:00').toLocaleDateString(
            'en-US',
            { month: 'short', day: 'numeric' }
          ),
          daysUntil: fathersMeta.daysUntil,
          icon: 'handyman',
          accentColor: '#1d4ed8',
        });
      }
    }

    return events.sort((a, b) => a.daysUntil - b.daysUntil);
  }

  private getNthSundayOfMonth(
    year: number,
    monthZeroIndexed: number,
    nth: number
  ): Date {
    const firstDay = new Date(year, monthZeroIndexed, 1);
    const firstSundayOffset = (7 - firstDay.getDay()) % 7;
    const dayOfMonth = 1 + firstSundayOffset + (nth - 1) * 7;
    return new Date(year, monthZeroIndexed, dayOfMonth);
  }

  private inferOccasionsForRelationship(
    relationship: ContactRelationship,
    hasBirthday: boolean
  ): GiftOccasionId[] {
    const set = new Set<GiftOccasionId>(['christmas']);
    if (hasBirthday) set.add('birthday');
    if (relationship === 'Mom') set.add('mothers_day');
    if (relationship === 'Dad') set.add('fathers_day');
    if (relationship === 'Partner') set.add('anniversary');
    return Array.from(set);
  }

  private normalizeRelationship(val: string): ContactRelationship {
    const v = val.trim().toLowerCase();
    if (v === 'mom' || v === 'mother' || v === 'mama') return 'Mom';
    if (v === 'dad' || v === 'father' || v === 'papa') return 'Dad';
    if (
      v === 'partner' ||
      v === 'spouse' ||
      v === 'wife' ||
      v === 'husband' ||
      v === 'girlfriend' ||
      v === 'boyfriend'
    )
      return 'Partner';
    if (v === 'sibling' || v === 'brother' || v === 'sister') return 'Sibling';
    if (v === 'child' || v === 'son' || v === 'daughter') return 'Child';
    if (v === 'grandparent' || v === 'grandma' || v === 'grandpa')
      return 'Grandparent';
    if (v === 'friend' || v === 'best friend') return 'Friend';
    if (
      v === 'relative' ||
      v === 'sister-in-law' ||
      v === 'brother-in-law' ||
      v === 'aunt' ||
      v === 'uncle' ||
      v === 'cousin'
    )
      return 'Relative';
    if (v === 'colleague' || v === 'coworker' || v === 'manager')
      return 'Colleague';
    return 'Other';
  }

  private mapGooglePersonToSantaContact(
    person: any,
    accountEmail: string,
    index: number,
    existing?: SantaContact
  ): SantaContact | null {
    const primaryName = person.names?.[0];
    const primaryEmail = person.emailAddresses?.[0]?.value;
    const displayName =
      primaryName?.displayName || primaryEmail || existing?.displayName;
    if (!displayName) return null;

    const givenName = primaryName?.givenName || displayName.split(' ')[0];
    const familyName =
      primaryName?.familyName || displayName.split(' ').slice(1).join(' ');
    const initials = (
      (givenName[0] || '') + (familyName[0] || givenName[1] || '')
    ).toUpperCase();

    const bdayRaw = person.birthdays?.[0]?.date;
    const birthday: BirthdayDate | undefined =
      bdayRaw && bdayRaw.month && bdayRaw.day
        ? {
            year: bdayRaw.year || undefined,
            month: bdayRaw.month,
            day: bdayRaw.day,
          }
        : existing?.birthday;

    const rawBio =
      person.biographies?.[0]?.value ?? existing?.rawBiography ?? '';
    const relationHintRaw = person.relations?.[0]?.type || '';
    const fallbackRel = existing?.giftProfile.relationship
      ? existing.giftProfile.relationship
      : relationHintRaw
        ? this.normalizeRelationship(relationHintRaw)
        : 'Friend';

    const giftProfile = this.parseContactNotes(rawBio, birthday, fallbackRel);

    return {
      resourceName: person.resourceName || `people/google-${index}`,
      etag: person.etag || existing?.etag || `"etag-${Date.now()}"`,
      accountEmail,
      displayName,
      givenName,
      familyName,
      email: primaryEmail,
      photoUrl: person.photos?.[0]?.url,
      initials,
      avatarColor:
        existing?.avatarColor || AVATAR_PALETTE[index % AVATAR_PALETTE.length],
      birthday,
      rawBiography: rawBio,
      giftProfile,
      selectedForSanta:
        existing?.selectedForSanta ?? Boolean(birthday || rawBio.trim()),
      syncStatus: 'synced',
      lastSyncedAt: new Date().toISOString(),
    };
  }

  private replaceContact(updatedContact: SantaContact): void {
    const next = this.contacts().map((c) =>
      c.resourceName === updatedContact.resourceName ? updatedContact : c
    );
    this.contacts.set(next);
    this.persistContacts(next);
  }

  private updateContactSyncStatus(
    resourceName: string,
    status: SantaContact['syncStatus'],
    syncError?: string
  ): void {
    const next = this.contacts().map((c) =>
      c.resourceName === resourceName
        ? { ...c, syncStatus: status, syncError }
        : c
    );
    this.contacts.set(next);
  }

  private loadOAuthConfig(): GoogleOAuthConfig {
    const defaultRedirect =
      typeof window !== 'undefined'
        ? window.location.origin + window.location.pathname
        : 'http://localhost:4206/';
    try {
      const raw = localStorage.getItem(OAUTH_CONFIG_STORAGE_KEY);
      if (raw) {
        return { redirectUri: defaultRedirect, ...JSON.parse(raw) };
      }
    } catch {
      // Ignore
    }
    return {
      clientId: '',
      clientSecret: '',
      redirectUri: defaultRedirect,
      geminiApiKey: '',
    };
  }

  private loadAccounts(): ConnectedGoogleAccount[] {
    try {
      const raw = localStorage.getItem(GOOGLE_ACCOUNTS_STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      // Ignore
    }
    return [];
  }

  private persistAccounts(accounts: ConnectedGoogleAccount[]): void {
    try {
      localStorage.setItem(
        GOOGLE_ACCOUNTS_STORAGE_KEY,
        JSON.stringify(accounts)
      );
    } catch {
      // Ignore
    }
  }

  private loadContacts(): SantaContact[] {
    try {
      const raw = localStorage.getItem(CONTACTS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // Ignore
    }
    return this.getDefaultDemoContacts();
  }

  private persistContacts(contacts: SantaContact[]): void {
    try {
      localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(contacts));
    } catch {
      // Ignore
    }
  }

  getDefaultDemoContacts(): SantaContact[] {
    const seed: Array<{
      resourceName: string;
      displayName: string;
      email: string;
      birthday?: BirthdayDate;
      relationship: ContactRelationship;
      selectedForSanta: boolean;
      freeformNotes: string;
      likes: string[];
      dislikes: string[];
      sizes: string;
      favoriteBrands: string[];
      budget: { min: number; max: number };
      pastGifts: string[];
    }> = [
      {
        resourceName: 'people/c101-linda-mom',
        displayName: 'Linda Felker',
        email: 'linda.felker@example.com',
        birthday: { year: 1964, month: 12, day: 4 },
        relationship: 'Mom',
        selectedForSanta: true,
        freeformNotes:
          'Loves morning pour-over coffee on the porch, heirloom vegetable gardening, cozy sci-fi novels (Becky Chambers, Project Hail Mary), and national park trails.',
        likes: [
          'Pour-over coffee',
          'Heirloom gardening',
          'Cozy sci-fi books',
          'Merino wool layers',
          'Botanical ceramics',
        ],
        dislikes: ['Strong synthetic perfumes', 'High-maintenance counter gadgets'],
        sizes: 'Sweater M, Shoe 8.5',
        favoriteBrands: ['Fellow', 'REI Co-op', 'Bookshop.org', 'Le Creuset'],
        budget: { min: 45, max: 160 },
        pastGifts: ['Kindle Paperwhite (2025)'],
      },
      {
        resourceName: 'people/c102-robert-dad',
        displayName: 'Robert Felker',
        email: 'robert.felker@example.com',
        birthday: { year: 1962, month: 6, day: 18 },
        relationship: 'Dad',
        selectedForSanta: true,
        freeformNotes:
          'Avid backyard cast-iron & smoked brisket cook, vinyl jazz collector, and national history buff. Appreciates durable tools that last decades.',
        likes: [
          'Cast-iron cooking',
          'BBQ & smoking',
          'Vinyl jazz records',
          'Precision pocket tools',
          'History & biography books',
        ],
        dislikes: ['Novelty neckties', 'Cheap plastic grilling sets'],
        sizes: 'Jacket L, Glove L, Shoe 10.5',
        favoriteBrands: ['Williams Sonoma', 'Sonos', 'REI Co-op', 'Patagonia'],
        budget: { min: 50, max: 200 },
        pastGifts: ['Yeti Tundra Cooler (2025)'],
      },
      {
        resourceName: 'people/c103-maya-partner',
        displayName: 'Maya Lin',
        email: 'maya.lin@example.com',
        birthday: { year: 1995, month: 11, day: 29 },
        relationship: 'Partner',
        selectedForSanta: true,
        freeformNotes:
          'Design-obsessed architect who loves matcha lattes, minimalist home lighting, ceramic studio pottery, and weekend cabin trips.',
        likes: [
          'Ceremonial matcha',
          'Minimalist lamps & design',
          'Travel weekender bags',
          'Spa & hinoki wood scents',
          'Art & architecture monographs',
        ],
        dislikes: ['Gimmicky smart-home displays', 'Loud logos'],
        sizes: 'Top S, Ring 6, Shoe 7.5',
        favoriteBrands: ['Fellow', 'Lululemon', 'Uncommon Goods', 'Taschen'],
        budget: { min: 75, max: 250 },
        pastGifts: ['Aesop Hand Care Duet'],
      },
      {
        resourceName: 'people/c104-samir-brother',
        displayName: 'Samir Patel',
        email: 'samir.patel@example.com',
        birthday: { year: 1993, month: 1, day: 14 },
        relationship: 'Sibling',
        selectedForSanta: true,
        freeformNotes:
          'Software engineer & mechanical keyboard tinkerer. Huge fan of complex board games (Dune Imperium, Terraforming Mars), Lego Collector sets, and espresso.',
        likes: [
          'Strategy board games',
          'Lego Collector sets',
          'Espresso accessories',
          'Smart desk lighting',
          'Sci-fi hardcovers',
        ],
        dislikes: ['Generic gift cards'],
        sizes: 'Hoodie M, Shoe 10',
        favoriteBrands: ['Lego', 'Fellow', 'Sonos', 'Bookshop.org'],
        budget: { min: 35, max: 140 },
        pastGifts: ['Keychron Q1 Pro'],
      },
      {
        resourceName: 'people/c105-alex-friend',
        displayName: 'Alex Rivera',
        email: 'alex.rivera@example.com',
        birthday: { year: 1994, month: 3, day: 22 },
        relationship: 'Friend',
        selectedForSanta: true,
        freeformNotes:
          'Ultralight backpacker, bikepacking enthusiast, and sourdough baker. Always planning the next Sierra trail.',
        likes: [
          'Ultralight camping gear',
          'Sourdough baking',
          'Trail running',
          'National Park maps',
        ],
        dislikes: ['Heavy cotton clothing'],
        sizes: 'Shirt M, Sock L',
        favoriteBrands: ['REI Co-op', 'Patagonia', 'Williams Sonoma'],
        budget: { min: 30, max: 100 },
        pastGifts: ['Aeropress Go'],
      },
      {
        resourceName: 'people/c106-elena-sil',
        displayName: 'Elena Rostova',
        email: 'elena.rostova@example.com',
        birthday: { year: 1992, month: 5, day: 9 },
        relationship: 'Relative',
        selectedForSanta: true,
        freeformNotes:
          'New mom who loves restorative yoga, silk sleep accessories, herbal tea rituals, and audiobooks during stroller walks.',
        likes: [
          'Herbal tea & wellness',
          'Cozy loungewear',
          'Yoga & recovery',
          'Compact wireless audio',
        ],
        dislikes: ['Caffeinated coffee'],
        sizes: 'Loungewear S/M',
        favoriteBrands: ['Lululemon', 'Uncommon Goods', 'Sonos'],
        budget: { min: 40, max: 150 },
        pastGifts: [],
      },
      // Additional contacts in Google Contacts not yet selected into Gift Circle
      {
        resourceName: 'people/c107-jordan-colleague',
        displayName: 'Jordan Vance',
        email: 'jordan.vance@example.com',
        birthday: { year: 1989, month: 8, day: 19 },
        relationship: 'Colleague',
        selectedForSanta: false,
        freeformNotes: 'Tech lead on partner integrations; loves single-origin cold brew and fountain pens.',
        likes: ['Cold brew coffee', 'Stationery & pens'],
        dislikes: [],
        sizes: '',
        favoriteBrands: ['Fellow'],
        budget: { min: 25, max: 60 },
        pastGifts: [],
      },
      {
        resourceName: 'people/c108-claire-aunt',
        displayName: 'Claire Bennett',
        email: 'claire.bennett@example.com',
        birthday: { year: 1959, month: 4, day: 11 },
        relationship: 'Relative',
        selectedForSanta: false,
        freeformNotes: 'Aunt Claire in Vermont — loves watercolor painting, birdwatching, and artisanal jams.',
        likes: ['Watercolor painting', 'Birdwatching', 'Gourmet food baskets'],
        dislikes: [],
        sizes: 'Scarf One Size',
        favoriteBrands: ['Uncommon Goods', 'Williams Sonoma'],
        budget: { min: 40, max: 95 },
        pastGifts: [],
      },
    ];

    return seed.map((item, idx) => {
      const occasions = this.inferOccasionsForRelationship(
        item.relationship,
        Boolean(item.birthday)
      );
      if (item.resourceName.includes('elena')) {
        occasions.push('mothers_day');
      }
      const profile: StructuredGiftProfile = {
        freeformNotes: item.freeformNotes,
        relationship: item.relationship,
        occasions: Array.from(new Set(occasions)),
        likes: item.likes,
        dislikes: item.dislikes,
        sizes: item.sizes,
        favoriteBrands: item.favoriteBrands,
        targetBudget: item.budget,
        pastGifts: item.pastGifts,
      };
      const parts = item.displayName.split(' ');
      return {
        resourceName: item.resourceName,
        etag: `"etag-seed-${idx + 1}"`,
        accountEmail: 'demo@contacts.google.com',
        displayName: item.displayName,
        givenName: parts[0],
        familyName: parts.slice(1).join(' '),
        email: item.email,
        initials: (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase(),
        avatarColor: AVATAR_PALETTE[idx % AVATAR_PALETTE.length],
        birthday: item.birthday,
        rawBiography: this.serializeContactNotes(profile),
        giftProfile: profile,
        selectedForSanta: item.selectedForSanta,
        syncStatus: 'demo_local',
        lastSyncedAt: '2026-11-17T15:30:00Z',
      };
    });
  }
}
