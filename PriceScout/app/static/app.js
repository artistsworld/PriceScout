/**
 * PriceScout — Minimal Clean Frontend Logic
 * Includes Dual-store Scraping, Strict Relevance Filter,
 * and Supabase User Authentication & Cloud Wishlist Sync
 */

(function () {
  'use strict';

  // Supabase Client Reference & Auth State
  let supabaseClient = null;
  let currentUser = null;
  let wishlistItems = []; // Array of saved products

  // Application State
  const state = {
    query: 'iPhone 16',
    source: 'all', // 'all', 'amazon', 'flipkart'
    viewMode: 'split', // 'split', 'merged'
    amazonProducts: [],
    flipkartProducts: [],
    cached: false,
    latencyMs: 0,
    filters: {
      sort: '',
      minPrice: null,
      maxPrice: null,
      dealsOnly: false,
      ratedFour: false,
      strictMode: true,
    },
    comparedProducts: [], // max 2
  };

  // DOM Elements - Search & Header
  const searchForm = document.getElementById('search-form');
  const searchInput = document.getElementById('search-input');
  const clearSearchBtn = document.getElementById('clear-search-btn');
  const sourceInputs = document.querySelectorAll('input[name="source"]');
  const viewSplitBtn = document.getElementById('view-split-btn');
  const viewMergedBtn = document.getElementById('view-merged-btn');
  const sortSelect = document.getElementById('sort-select');
  const btnPurgeCache = document.getElementById('btn-purge-cache');

  // Headers & Banners
  const queryDisplay = document.getElementById('query-display');
  const infoBanner = document.getElementById('info-banner');
  const bannerText = document.getElementById('banner-text');
  const resultsCountText = document.getElementById('results-count-text');
  const latencyText = document.getElementById('latency-text');

  // Containers
  const loadingState = document.getElementById('loading-state');
  const emptyState = document.getElementById('empty-state');
  const splitViewContainer = document.getElementById('split-view-container');
  const mergedGridContainer = document.getElementById('merged-grid-container');
  const amazonProductsGrid = document.getElementById('amazon-products-grid');
  const flipkartProductsGrid = document.getElementById('flipkart-products-grid');
  const mergedProductsGrid = document.getElementById('merged-products-grid');
  const amazonCount = document.getElementById('amazon-count');
  const flipkartCount = document.getElementById('flipkart-count');

  // Filter Pills
  const pillStrict = document.getElementById('filter-pill-strict');
  const pillDeals = document.getElementById('filter-pill-deals');
  const pillFourStar = document.getElementById('filter-pill-fourstar');
  const pillUnder10k = document.getElementById('filter-pill-under10k');
  const pillUnder50k = document.getElementById('filter-pill-under50k');
  const pillReset = document.getElementById('filter-pill-reset');

  // Compare Tray & Modal
  const compareTray = document.getElementById('compare-tray');
  const trayCount = document.getElementById('tray-count');
  const trayPreviews = document.getElementById('tray-previews');
  const btnOpenCompare = document.getElementById('btn-open-compare');
  const btnClearCompare = document.getElementById('btn-clear-compare');
  const compareModal = document.getElementById('compare-modal');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const compareModalContent = document.getElementById('compare-modal-content');

  // Wishlist & Auth Elements
  const btnOpenWishlist = document.getElementById('btn-open-wishlist');
  const wishlistBadge = document.getElementById('wishlist-badge');
  const wishlistModal = document.getElementById('wishlist-modal');
  const wishlistCloseBtn = document.getElementById('wishlist-close-btn');
  const wishlistContent = document.getElementById('wishlist-content');
  const wishlistModalCount = document.getElementById('wishlist-modal-count');

  // Auth Modal Elements
  const btnAuthModal = document.getElementById('btn-auth-modal');
  const authBtnText = document.getElementById('auth-btn-text');
  const userProfileMenu = document.getElementById('user-profile-menu');
  const userAvatarInitial = document.getElementById('user-avatar-initial');
  const userEmailText = document.getElementById('user-email-text');
  const btnLogout = document.getElementById('btn-logout');

  const authModal = document.getElementById('auth-modal');
  const authCloseBtn = document.getElementById('auth-close-btn');
  const authModalTitle = document.getElementById('auth-modal-title');
  const tabLogin = document.getElementById('tab-login');
  const tabSignup = document.getElementById('tab-signup');
  const tabConfig = document.getElementById('tab-config');
  const authForm = document.getElementById('auth-form');
  const authEmail = document.getElementById('auth-email');
  const authPassword = document.getElementById('auth-password');
  const authErrorMsg = document.getElementById('auth-error-msg');
  const authSubmitBtn = document.getElementById('auth-submit-btn');

  const supabaseConfigPanel = document.getElementById('supabase-config-panel');
  const inputSupabaseUrl = document.getElementById('input-supabase-url');
  const inputSupabaseKey = document.getElementById('input-supabase-key');
  const btnSaveSupabaseConfig = document.getElementById('btn-save-supabase-config');

  const toastCenter = document.getElementById('toast-center');

  let currentAuthMode = 'login'; // 'login', 'signup', 'config'

  // INR Formatter
  const inrFormatter = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  });

  // Init
  async function init() {
    bindEvents();
    await loadSiteSettings();
    await initSupabase();
    // Default search for iPhone 16
    searchInput.value = 'iPhone 16';
    clearSearchBtn.style.display = 'flex';
    fetchSearchResults();
  }

  // Load Dynamic Settings from /api/settings
  async function loadSiteSettings() {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        if (data.brand_name) {
          const brandEl = document.querySelector('.brand-name');
          if (brandEl) brandEl.textContent = data.brand_name;
        }
        if (data.badge_text) {
          const badgeEl = document.querySelector('.status-text');
          if (badgeEl) badgeEl.textContent = data.badge_text;
        }
        if (data.hero_headline_1) {
          const h1El = document.querySelector('.headline-primary');
          if (h1El) h1El.textContent = data.hero_headline_1;
        }
        if (data.hero_headline_2) {
          const h2El = document.querySelector('.headline-secondary');
          if (h2El) h2El.textContent = data.hero_headline_2;
        }
        if (data.hero_subtitle) {
          const subEl = document.querySelector('.hero-subtitle');
          if (subEl) subEl.textContent = data.hero_subtitle;
        }
      }
    } catch (e) {
      console.warn('Could not load site settings:', e);
    }
  }

  // ==========================================================================
  // Supabase Authentication & Initialization
  // ==========================================================================
  async function initSupabase() {
    let url = localStorage.getItem('ps_supabase_url') || '';
    let key = localStorage.getItem('ps_supabase_key') || '';

    // Fetch from backend /api/config if not in local storage
    if (!url || !key) {
      try {
        const res = await fetch('/api/config');
        if (res.ok) {
          const config = await res.json();
          if (config.supabase_url && config.supabase_anon_key) {
            url = config.supabase_url;
            key = config.supabase_anon_key;
          }
        }
      } catch (err) {
        console.warn('Could not fetch server Supabase config:', err);
      }
    }

    if (url && key && window.supabase) {
      try {
        supabaseClient = window.supabase.createClient(url, key);
        inputSupabaseUrl.value = url;
        inputSupabaseKey.value = key;

        // Check active session
        const { data: { session } } = await supabaseClient.auth.getSession();
        handleSessionChange(session);

        // Listen for session changes (login, logout, token refresh)
        supabaseClient.auth.onAuthStateChange((_event, session) => {
          handleSessionChange(session);
        });
      } catch (e) {
        console.error('Supabase initialization error:', e);
      }
    } else {
      // Fallback: load local wishlist if Supabase not configured yet
      loadLocalWishlist();
    }
  }

  function handleSessionChange(session) {
    if (session && session.user) {
      currentUser = session.user;
      btnAuthModal.style.display = 'none';
      userProfileMenu.style.display = 'flex';
      const email = currentUser.email || 'User';
      userEmailText.textContent = email;
      userAvatarInitial.textContent = email.charAt(0).toUpperCase();
      loadUserWishlist();
    } else {
      currentUser = null;
      btnAuthModal.style.display = 'inline-flex';
      userProfileMenu.style.display = 'none';
      loadLocalWishlist();
    }
  }

  // ==========================================================================
  // Wishlist Storage (Cloud in Supabase + Local Cache)
  // ==========================================================================
  async function loadUserWishlist() {
    if (!supabaseClient || !currentUser) {
      loadLocalWishlist();
      return;
    }

    try {
      const { data, error } = await supabaseClient
        .from('wishlist')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.warn('Supabase wishlist select warning:', error.message);
        loadLocalWishlist();
        return;
      }

      wishlistItems = data || [];
      saveLocalWishlistCopy();
      updateWishlistUI();
    } catch (e) {
      console.warn('Error fetching cloud wishlist:', e);
      loadLocalWishlist();
    }
  }

  function loadLocalWishlist() {
    try {
      const raw = localStorage.getItem('ps_wishlist_items');
      wishlistItems = raw ? JSON.parse(raw) : [];
    } catch (e) {
      wishlistItems = [];
    }
    updateWishlistUI();
  }

  function saveLocalWishlistCopy() {
    try {
      localStorage.setItem('ps_wishlist_items', JSON.stringify(wishlistItems));
    } catch (e) {}
  }

  function updateWishlistUI() {
    const count = wishlistItems.length;
    wishlistBadge.textContent = count;
    wishlistModalCount.textContent = `${count} ${count === 1 ? 'item' : 'items'}`;

    // Update active hearts on visible cards
    document.querySelectorAll('.btn-card-wishlist').forEach(btn => {
      const card = btn.closest('.clean-card');
      if (card) {
        const id = card.getAttribute('data-product-id');
        const src = card.getAttribute('data-source');
        const isSaved = wishlistItems.some(item => item.product_id === id && item.source === src);
        btn.classList.toggle('active', isSaved);
      }
    });

    renderWishlistModal();
  }

  async function toggleWishlistProduct(product, btnElement) {
    const isSaved = wishlistItems.some(
      item => item.product_id === product.id && item.source === product.source
    );

    if (isSaved) {
      // Remove from wishlist
      wishlistItems = wishlistItems.filter(
        item => !(item.product_id === product.id && item.source === product.source)
      );
      btnElement.classList.remove('active');
      showToast('Removed from Wishlist');

      if (supabaseClient && currentUser) {
        try {
          await supabaseClient
            .from('wishlist')
            .delete()
            .eq('product_id', product.id)
            .eq('source', product.source);
        } catch (e) {
          console.warn('Error deleting wishlist item from Supabase:', e);
        }
      }
    } else {
      // Add to wishlist
      const newItem = {
        product_id: product.id,
        source: product.source,
        title: product.title,
        price: product.price || null,
        original_price: product.original_price || null,
        image: product.image || null,
        url: product.url,
        rating: product.rating || null,
        created_at: new Date().toISOString(),
      };

      wishlistItems.unshift(newItem);
      btnElement.classList.add('active');
      showToast('❤️ Added to Wishlist!');

      if (supabaseClient && currentUser) {
        try {
          const { error } = await supabaseClient.from('wishlist').insert([newItem]);
          if (error) {
            console.warn('Supabase insert note:', error.message);
          }
        } catch (e) {
          console.warn('Error inserting into Supabase:', e);
        }
      } else if (supabaseClient && !currentUser) {
        showToast('ℹ️ Sign in anytime to sync your wishlist to the cloud!');
      }
    }

    saveLocalWishlistCopy();
    updateWishlistUI();
  }

  async function removeWishlistItem(productId, source) {
    wishlistItems = wishlistItems.filter(
      item => !(item.product_id === productId && item.source === source)
    );
    showToast('Removed from Wishlist');

    if (supabaseClient && currentUser) {
      try {
        await supabaseClient
          .from('wishlist')
          .delete()
          .eq('product_id', productId)
          .eq('source', source);
      } catch (e) {
        console.warn('Supabase delete error:', e);
      }
    }

    saveLocalWishlistCopy();
    updateWishlistUI();
  }

  function renderWishlistModal() {
    if (wishlistItems.length === 0) {
      wishlistContent.innerHTML = `
        <div style="text-align:center;padding:3rem 1rem;color:var(--text-muted);">
          <div style="font-size:2.5rem;margin-bottom:0.75rem;">🤍</div>
          <h4 style="font-size:1.1rem;color:var(--text-main);margin-bottom:0.35rem;">Your wishlist is empty</h4>
          <p style="font-size:0.88rem;">Click the heart icon on any product to save it here for quick tracking.</p>
        </div>
      `;
      return;
    }

    wishlistContent.innerHTML = `
      <div class="wishlist-items-list">
        ${wishlistItems.map(item => {
          const isAmazon = item.source === 'amazon';
          return `
            <div class="wishlist-item" id="wish-item-${item.source}-${item.product_id}">
              <img src="${escapeHtml(item.image || '')}" alt="" class="wishlist-item-img" onerror="this.style.display='none';">
              <div class="wishlist-item-info">
                <div style="display:flex;align-items:center;gap:0.4rem;">
                  <span class="store-pill-mini ${isAmazon ? 'mini-amazon' : 'mini-flipkart'}">
                    ${isAmazon ? 'Amazon' : 'Flipkart'}
                  </span>
                </div>
                <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="wishlist-item-title" title="${escapeHtml(item.title)}">
                  ${escapeHtml(item.title)}
                </a>
                <div class="wishlist-item-price">
                  ${item.price ? inrFormatter.format(item.price) : 'Check Site'}
                </div>
              </div>
              <div class="wishlist-item-actions">
                <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="btn-card-buy ${isAmazon ? 'buy-amz' : 'buy-flp'}">
                  Buy ↗
                </a>
                <button type="button" class="btn-remove-wishlist" title="Remove item" data-id="${escapeHtml(item.product_id)}" data-source="${escapeHtml(item.source)}">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Bind remove clicks
    wishlistContent.querySelectorAll('.btn-remove-wishlist').forEach(btn => {
      btn.addEventListener('click', function () {
        const id = this.getAttribute('data-id');
        const src = this.getAttribute('data-source');
        removeWishlistItem(id, src);
      });
    });
  }

  // ==========================================================================
  // Bind UI Events
  // ==========================================================================
  function bindEvents() {
    // Search form submission
    searchForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const q = searchInput.value.trim();
      if (q) {
        state.query = q;
        fetchSearchResults();
      }
    });

    // Clear input button
    searchInput.addEventListener('input', function () {
      clearSearchBtn.style.display = searchInput.value ? 'flex' : 'none';
    });
    clearSearchBtn.addEventListener('click', function () {
      searchInput.value = '';
      clearSearchBtn.style.display = 'none';
      searchInput.focus();
    });

    // Try Searching chips
    document.querySelectorAll('.search-chip').forEach(chip => {
      chip.addEventListener('click', function () {
        const query = this.getAttribute('data-query');
        if (query) {
          searchInput.value = query;
          clearSearchBtn.style.display = 'flex';
          state.query = query;
          fetchSearchResults();
          window.scrollTo({ top: 380, behavior: 'smooth' });
        }
      });
    });

    // Store Source radio tabs
    sourceInputs.forEach(input => {
      input.addEventListener('change', function () {
        document.querySelectorAll('.store-tab').forEach(t => t.classList.remove('active'));
        this.closest('.store-tab').classList.add('active');
        state.source = this.value;
        if (state.query) {
          fetchSearchResults();
        }
      });
    });

    // View Switcher (Split vs Unified)
    viewSplitBtn.addEventListener('click', () => setViewMode('split'));
    viewMergedBtn.addEventListener('click', () => setViewMode('merged'));

    // Sort order
    sortSelect.addEventListener('change', function () {
      state.filters.sort = this.value;
      renderResults();
    });

    // Strict Relevance Filter Pill
    if (pillStrict) {
      pillStrict.addEventListener('click', function () {
        state.filters.strictMode = !state.filters.strictMode;
        this.classList.toggle('active', state.filters.strictMode);
        renderResults();
        showToast(state.filters.strictMode ? '🎯 Strict relevance filter enabled' : '⚠️ Strict filter disabled (showing all results)');
      });
    }

    // Filter pills
    pillDeals.addEventListener('click', function () {
      state.filters.dealsOnly = !state.filters.dealsOnly;
      this.classList.toggle('active', state.filters.dealsOnly);
      renderResults();
    });

    pillFourStar.addEventListener('click', function () {
      state.filters.ratedFour = !state.filters.ratedFour;
      this.classList.toggle('active', state.filters.ratedFour);
      renderResults();
    });

    pillUnder10k.addEventListener('click', function () {
      if (state.filters.maxPrice === 10000) {
        state.filters.maxPrice = null;
        this.classList.remove('active');
      } else {
        state.filters.maxPrice = 10000;
        pillUnder50k.classList.remove('active');
        this.classList.add('active');
      }
      renderResults();
    });

    pillUnder50k.addEventListener('click', function () {
      if (state.filters.maxPrice === 50000) {
        state.filters.maxPrice = null;
        this.classList.remove('active');
      } else {
        state.filters.maxPrice = 50000;
        pillUnder10k.classList.remove('active');
        this.classList.add('active');
      }
      renderResults();
    });

    pillReset.addEventListener('click', resetFilters);

    // Refresh Cache
    btnPurgeCache.addEventListener('click', purgeCache);

    // Wishlist Modal open/close
    btnOpenWishlist.addEventListener('click', () => {
      wishlistModal.style.display = 'flex';
      renderWishlistModal();
    });
    wishlistCloseBtn.addEventListener('click', () => {
      wishlistModal.style.display = 'none';
    });
    wishlistModal.addEventListener('click', (e) => {
      if (e.target === wishlistModal) wishlistModal.style.display = 'none';
    });

    // Auth Modal open/close
    btnAuthModal.addEventListener('click', () => openAuthModal('login'));
    authCloseBtn.addEventListener('click', () => {
      authModal.style.display = 'none';
    });
    authModal.addEventListener('click', (e) => {
      if (e.target === authModal) authModal.style.display = 'none';
    });

    // Auth Tabs
    tabLogin.addEventListener('click', () => switchAuthTab('login'));
    tabSignup.addEventListener('click', () => switchAuthTab('signup'));
    tabConfig.addEventListener('click', () => switchAuthTab('config'));

    // Auth Form Submit
    authForm.addEventListener('submit', handleAuthSubmit);

    // Save Supabase credentials button
    btnSaveSupabaseConfig.addEventListener('click', handleSaveSupabaseConfig);

    // Logout
    btnLogout.addEventListener('click', handleLogout);

    // Compare Tray Actions
    btnOpenCompare.addEventListener('click', openCompareModal);
    btnClearCompare.addEventListener('click', clearComparison);
    modalCloseBtn.addEventListener('click', closeCompareModal);
    compareModal.addEventListener('click', function (e) {
      if (e.target === compareModal) closeCompareModal();
    });

    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeCompareModal();
        wishlistModal.style.display = 'none';
        authModal.style.display = 'none';
      }
    });
  }

  // ==========================================================================
  // Auth Form Handlers
  // ==========================================================================
  function openAuthModal(tab = 'login') {
    authModal.style.display = 'flex';
    switchAuthTab(tab);
    authErrorMsg.style.display = 'none';
  }

  function switchAuthTab(tab) {
    currentAuthMode = tab;
    tabLogin.classList.toggle('active', tab === 'login');
    tabSignup.classList.toggle('active', tab === 'signup');
    tabConfig.classList.toggle('active', tab === 'config');

    authErrorMsg.style.display = 'none';

    if (tab === 'config') {
      authModalTitle.textContent = 'Supabase Project Setup';
      authForm.style.display = 'none';
      supabaseConfigPanel.style.display = 'flex';
    } else {
      supabaseConfigPanel.style.display = 'none';
      authForm.style.display = 'flex';
      if (tab === 'login') {
        authModalTitle.textContent = 'Sign In to PriceScout';
        authSubmitBtn.querySelector('span').textContent = 'Sign In';
      } else {
        authModalTitle.textContent = 'Create PriceScout Account';
        authSubmitBtn.querySelector('span').textContent = 'Sign Up';
      }
    }
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    authErrorMsg.style.display = 'none';

    if (!supabaseClient) {
      authErrorMsg.textContent = 'Please configure your Supabase URL & Anon Key in the "Supabase Keys" tab first.';
      authErrorMsg.style.display = 'block';
      return;
    }

    const email = authEmail.value.trim();
    const password = authPassword.value;
    authSubmitBtn.disabled = true;

    try {
      if (currentAuthMode === 'signup') {
        const { data, error } = await supabaseClient.auth.signUp({ email, password });
        if (error) throw error;
        showToast('Account created! Please check your email to verify if required.');
        authModal.style.display = 'none';
      } else {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        showToast('Signed in successfully!');
        authModal.style.display = 'none';
      }
    } catch (err) {
      authErrorMsg.textContent = err.message || 'Authentication error';
      authErrorMsg.style.display = 'block';
    } finally {
      authSubmitBtn.disabled = false;
    }
  }

  async function handleSaveSupabaseConfig() {
    const url = inputSupabaseUrl.value.trim();
    const key = inputSupabaseKey.value.trim();

    if (!url || !key) {
      alert('Please enter both Supabase URL and Anon Key.');
      return;
    }

    localStorage.setItem('ps_supabase_url', url);
    localStorage.setItem('ps_supabase_key', key);

    await initSupabase();
    showToast('Supabase credentials saved successfully!');
    switchAuthTab('login');
  }

  async function handleLogout() {
    if (supabaseClient) {
      await supabaseClient.auth.signOut();
    }
    currentUser = null;
    handleSessionChange(null);
    showToast('Signed out');
  }

  // ==========================================================================
  // View Mode & Purge Cache
  // ==========================================================================
  function setViewMode(mode) {
    state.viewMode = mode;
    if (mode === 'split') {
      viewSplitBtn.classList.add('active');
      viewMergedBtn.classList.remove('active');
    } else {
      viewMergedBtn.classList.add('active');
      viewSplitBtn.classList.remove('active');
    }
    renderResults();
  }

  async function purgeCache() {
    btnPurgeCache.disabled = true;
    try {
      const res = await fetch('/api/cache', { method: 'DELETE' });
      if (res.ok) {
        showToast('⚡ Cache purged! Fresh results will be fetched.');
        fetchSearchResults();
      } else {
        showToast('Failed to clear cache.', 'danger');
      }
    } catch (e) {
      showToast('Cache purge error.', 'danger');
    } finally {
      btnPurgeCache.disabled = false;
    }
  }

  // ==========================================================================
  // Fetch Search Results
  // ==========================================================================
  async function fetchSearchResults() {
    showLoading();
    queryDisplay.textContent = state.query;
    const startTime = performance.now();

    try {
      const params = new URLSearchParams();
      params.append('q', state.query);
      params.append('source', state.source);
      params.append('strict', state.filters.strictMode ? 'true' : 'false');

      const response = await fetch(`/api/search?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Server returned HTTP ${response.status}`);
      }

      const data = await response.json();
      state.latencyMs = Math.round(performance.now() - startTime);

      let amazonResults = [];
      let flipkartResults = [];
      let isCached = false;

      if (Array.isArray(data)) {
        data.forEach(item => {
          if (item.source === 'amazon') {
            amazonResults = item.products || [];
          } else if (item.source === 'flipkart') {
            flipkartResults = item.products || [];
          }
          if (item.cached) isCached = true;
        });
      }

      state.amazonProducts = amazonResults;
      state.flipkartProducts = flipkartResults;
      state.cached = isCached;

      // Update Info Banner text
      if (amazonResults.length > 0 && flipkartResults.length > 0) {
        bannerText.textContent = `Found ${amazonResults.length} listings on Amazon India and ${flipkartResults.length} on Flipkart for "${state.query}".`;
      } else if (amazonResults.length > 0) {
        bannerText.textContent = `Found ${amazonResults.length} listings on Amazon India for "${state.query}".`;
      } else if (flipkartResults.length > 0) {
        bannerText.textContent = `Found ${flipkartResults.length} listings on Flipkart for "${state.query}".`;
      } else {
        bannerText.textContent = `No listings returned for "${state.query}". Try a broader term.`;
      }

      renderResults();
    } catch (err) {
      console.error('Fetch error:', err);
      showEmpty('Search Failed', 'Could not retrieve live product listings. Please check your network and retry.');
    }
  }

  // ==========================================================================
  // Product Relevance Rules (Filter out accessories & irrelevant items)
  // ==========================================================================
  function isRelevantProduct(title, query) {
    if (!title || !query) return true;
    const titleLower = title.toLowerCase();
    const qLower = query.toLowerCase();

    // 1. Accessory exclusions if not requested in query
    const accessoryWords = [
      'case', 'cover', 'back cover', 'glass', 'tempered', 'tempered glass',
      'protector', 'screen protector', 'skin', 'cable', 'charger',
      'adapter', 'guard', 'strap', 'pouch', 'sleeve', 'dock', 'stand', 'camera lens'
    ];
    const userWantsAccessories = accessoryWords.some(w => qLower.includes(w));
    if (!userWantsAccessories) {
      for (const w of accessoryWords) {
        const regex = new RegExp(`\\b${w}\\b`, 'i');
        if (regex.test(titleLower)) return false;
      }
    }

    // 2. Query token matching
    const fillerWords = new Set(['for', 'and', 'with', 'the', 'best', 'online', 'india', 'buy', 'new', 'genuine', 'original', 'series']);
    const qTokens = (qLower.match(/[a-z0-9]+/g) || []).filter(w => w.length > 1 && !fillerWords.has(w));
    if (qTokens.length === 0) return true;

    const matchedTokens = qTokens.filter(t => titleLower.includes(t));
    if (matchedTokens.length / qTokens.length < 0.5) return false;

    // 3. Model number precision check (e.g. 16, 24, 15, xm5, m3)
    const modelTokens = qTokens.filter(w => /\d/.test(w) || ['macbook', 'ipad', 'iphone', 'pixel', 'galaxy', 'bravia'].includes(w));
    for (const mt of modelTokens) {
      if (!titleLower.includes(mt)) return false;
    }

    // 4. Competing brand conflict check (e.g. if query is iPhone, exclude Samsung/Vivo/OnePlus ads)
    if (qLower.includes('iphone') || qLower.includes('apple')) {
      const competing = ['galaxy', 'samsung', 'vivo', 'oneplus', 'redmi', 'xiaomi', 'realme', 'motorola', 'moto', 'poco'];
      if (competing.some(b => titleLower.includes(b))) return false;
    } else if (qLower.includes('galaxy') || qLower.includes('samsung')) {
      const competing = ['iphone', 'apple', 'pixel', 'oneplus', 'vivo', 'oppo'];
      if (competing.some(b => titleLower.includes(b))) return false;
    }

    return true;
  }

  // Filter & Sort Logic
  function processProducts(products) {
    let list = [...products];

    // Filter: Strict relevance (only genuine search products)
    if (state.filters.strictMode) {
      const relevant = list.filter(p => isRelevantProduct(p.title, state.query));
      if (relevant.length > 0) {
        list = relevant;
      }
    }

    // Filter: Max price
    if (state.filters.maxPrice !== null) {
      list = list.filter(p => p.price && p.price <= state.filters.maxPrice);
    }

    // Filter: 4★ and above
    if (state.filters.ratedFour) {
      list = list.filter(p => p.rating && p.rating >= 4.0);
    }

    // Filter: High discounts only (>= 20%)
    if (state.filters.dealsOnly) {
      list = list.filter(p => {
        if (!p.price || !p.original_price) return false;
        const discount = ((p.original_price - p.price) / p.original_price) * 100;
        return discount >= 20;
      });
    }

    // Sorting
    if (state.filters.sort === 'price_asc') {
      list.sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
    } else if (state.filters.sort === 'price_desc') {
      list.sort((a, b) => (b.price || 0) - (a.price || 0));
    } else if (state.filters.sort === 'rating_desc') {
      list.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    } else if (state.filters.sort === 'discount_desc') {
      list.sort((a, b) => {
        const discA = a.original_price && a.price ? (a.original_price - a.price) / a.original_price : 0;
        const discB = b.original_price && b.price ? (b.original_price - b.price) / b.original_price : 0;
        return discB - discA;
      });
    }

    return list;
  }

  // Detect Best Deal across stores
  function markBestDeals(amazonList, flipkartList) {
    if (amazonList.length === 0 || flipkartList.length === 0) return;
    const minAmz = amazonList.reduce((min, p) => p.price && p.price < min ? p.price : min, Infinity);
    const minFlp = flipkartList.reduce((min, p) => p.price && p.price < min ? p.price : min, Infinity);

    if (minAmz !== Infinity && minFlp !== Infinity) {
      if (minAmz < minFlp) {
        const best = amazonList.find(p => p.price === minAmz);
        if (best) best.isBestDeal = true;
      } else if (minFlp < minAmz) {
        const best = flipkartList.find(p => p.price === minFlp);
        if (best) best.isBestDeal = true;
      }
    }
  }

  // ==========================================================================
  // Render Results
  // ==========================================================================
  function renderResults() {
    loadingState.style.display = 'none';

    const processedAmazon = processProducts(state.amazonProducts);
    const processedFlipkart = processProducts(state.flipkartProducts);

    markBestDeals(processedAmazon, processedFlipkart);

    const totalCount = processedAmazon.length + processedFlipkart.length;
    resultsCountText.textContent = `${totalCount} products found`;
    latencyText.textContent = `${state.latencyMs}ms ${state.cached ? '(Cached)' : ''}`;

    if (totalCount === 0) {
      showEmpty('No matching products found', 'Try adjusting your filters or search keywords.');
      return;
    }

    emptyState.style.display = 'none';

    if (state.source === 'all' && state.viewMode === 'split') {
      splitViewContainer.style.display = 'grid';
      mergedGridContainer.style.display = 'none';

      amazonCount.textContent = `${processedAmazon.length} items`;
      flipkartCount.textContent = `${processedFlipkart.length} items`;

      amazonProductsGrid.innerHTML = '';
      processedAmazon.forEach(p => amazonProductsGrid.appendChild(createCleanCard(p)));

      flipkartProductsGrid.innerHTML = '';
      processedFlipkart.forEach(p => flipkartProductsGrid.appendChild(createCleanCard(p)));
    } else {
      splitViewContainer.style.display = 'none';
      mergedGridContainer.style.display = 'block';

      let merged = [];
      if (state.source === 'all') {
        merged = [...processedAmazon, ...processedFlipkart];
      } else if (state.source === 'amazon') {
        merged = [...processedAmazon];
      } else {
        merged = [...processedFlipkart];
      }

      if (state.filters.sort === 'price_asc') {
        merged.sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
      } else if (state.filters.sort === 'price_desc') {
        merged.sort((a, b) => (b.price || 0) - (a.price || 0));
      } else if (state.filters.sort === 'rating_desc') {
        merged.sort((a, b) => (b.rating || 0) - (a.rating || 0));
      }

      mergedProductsGrid.innerHTML = '';
      merged.forEach(p => mergedProductsGrid.appendChild(createCleanCard(p)));
    }
  }

  // ==========================================================================
  // Create Minimal Clean Card with Wishlist Heart
  // ==========================================================================
  function createCleanCard(product) {
    const card = document.createElement('div');
    card.className = 'clean-card';
    card.id = `item-${product.source}-${product.id}`;
    card.setAttribute('data-product-id', product.id);
    card.setAttribute('data-source', product.source);

    let discountPercent = null;
    if (product.original_price && product.price && product.original_price > product.price) {
      discountPercent = Math.round(((product.original_price - product.price) / product.original_price) * 100);
    }

    const isCompared = state.comparedProducts.some(p => p.id === product.id && p.source === product.source);
    const isWishlisted = wishlistItems.some(item => item.product_id === product.id && item.source === product.source);
    const isAmazon = product.source === 'amazon';
    const fallbackImg = "data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='1.5'%3e%3crect width='18' height='18' x='3' y='3' rx='2' ry='2'/%3e%3ccircle cx='9' cy='9' r='2'/%3e%3cpath d='m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21'/%3e%3c/svg%3e";
    const imgSrc = product.image ? escapeHtml(product.image) : fallbackImg;

    card.innerHTML = `
      <div class="clean-thumb-box">
        <img 
          src="${imgSrc}" 
          alt="${escapeHtml(product.title)}" 
          class="clean-card-img" 
          loading="lazy"
          onerror="this.onerror=null;this.src='${fallbackImg}';"
        />
      </div>

      <div class="clean-info">
        <div class="card-top-row">
          <span class="store-pill-mini ${isAmazon ? 'mini-amazon' : 'mini-flipkart'}">
            ${isAmazon ? 'Amazon' : 'Flipkart'}
          </span>
          ${product.isBestDeal ? '<span class="best-price-badge">🔥 Lowest price</span>' : ''}
          ${product.sponsored ? '<span style="font-size:0.65rem;color:#94a3b8;">Sponsored</span>' : ''}
          
          <!-- Wishlist Heart Button -->
          <button type="button" class="btn-card-wishlist ${isWishlisted ? 'active' : ''}" title="${isWishlisted ? 'Remove from Wishlist' : 'Add to Wishlist'}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="${isWishlisted ? '#ef4444' : 'none'}" stroke="currentColor" stroke-width="2">
              <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>
            </svg>
          </button>
        </div>

        <a href="${escapeHtml(product.url)}" target="_blank" rel="noopener noreferrer" class="clean-title" title="${escapeHtml(product.title)}">
          ${escapeHtml(product.title)}
        </a>

        ${product.rating ? `
          <div class="clean-rating">
            <span class="rating-star">★</span>
            <strong>${product.rating.toFixed(1)}</strong>
            <span>(${product.rating_count ? product.rating_count.toLocaleString() : 'Rated'})</span>
          </div>
        ` : ''}

        <div class="clean-price-row">
          <span class="clean-price">${product.price ? inrFormatter.format(product.price) : 'Check Store'}</span>
          ${product.original_price && product.original_price > product.price ? `
            <span class="clean-mrp">${inrFormatter.format(product.original_price)}</span>
          ` : ''}
          ${discountPercent ? `<span class="clean-discount">${discountPercent}% off</span>` : ''}
        </div>

        <div class="clean-actions">
          <a href="${escapeHtml(product.url)}" target="_blank" rel="noopener noreferrer" class="btn-card-buy ${isAmazon ? 'buy-amz' : 'buy-flp'}">
            <span>Buy on ${isAmazon ? 'Amazon' : 'Flipkart'}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M7 17L17 7M17 7H7M17 7V17"/>
            </svg>
          </a>

          <button type="button" class="btn-card-compare ${isCompared ? 'selected' : ''}">
            ${isCompared ? '✓ Selected' : '+ Compare'}
          </button>
        </div>
      </div>
    `;

    // Wishlist click
    const wishlistBtn = card.querySelector('.btn-card-wishlist');
    wishlistBtn.addEventListener('click', () => toggleWishlistProduct(product, wishlistBtn));

    // Compare click
    const compareBtn = card.querySelector('.btn-card-compare');
    compareBtn.addEventListener('click', () => toggleCompareProduct(product, compareBtn));

    return card;
  }

  // ==========================================================================
  // Head-to-Head Compare Logic
  // ==========================================================================
  function toggleCompareProduct(product, btnElement) {
    const idx = state.comparedProducts.findIndex(p => p.id === product.id && p.source === product.source);
    if (idx > -1) {
      state.comparedProducts.splice(idx, 1);
      btnElement.classList.remove('selected');
      btnElement.textContent = '+ Compare';
      showToast('Removed from comparison');
    } else {
      if (state.comparedProducts.length >= 2) {
        showToast('Max 2 products can be compared at once', 'warning');
        return;
      }
      state.comparedProducts.push(product);
      btnElement.classList.add('selected');
      btnElement.textContent = '✓ Selected';
      showToast('Added to comparison');
    }
    updateCompareTray();
  }

  function updateCompareTray() {
    const count = state.comparedProducts.length;
    trayCount.textContent = `${count}/2`;

    if (count > 0) {
      compareTray.style.display = 'block';
      trayPreviews.innerHTML = state.comparedProducts.map(p => `
        <img src="${p.image || ''}" alt="" class="tray-thumb" title="${escapeHtml(p.title)}">
      `).join('');
    } else {
      compareTray.style.display = 'none';
      trayPreviews.innerHTML = '';
    }

    btnOpenCompare.disabled = count !== 2;
  }

  function clearComparison() {
    state.comparedProducts = [];
    document.querySelectorAll('.btn-card-compare').forEach(btn => {
      btn.classList.remove('selected');
      btn.textContent = '+ Compare';
    });
    updateCompareTray();
  }

  function openCompareModal() {
    if (state.comparedProducts.length !== 2) return;
    const [p1, p2] = state.comparedProducts;

    let diffBanner = '';
    if (p1.price && p2.price) {
      const diff = Math.abs(p1.price - p2.price);
      if (diff === 0) {
        diffBanner = `<div class="compare-diff-card">Both products are identically priced at ${inrFormatter.format(p1.price)}</div>`;
      } else {
        const cheaper = p1.price < p2.price ? p1 : p2;
        diffBanner = `<div class="compare-diff-card">🎉 ${cheaper.source.toUpperCase()} is cheaper by ${inrFormatter.format(diff)}!</div>`;
      }
    }

    compareModalContent.innerHTML = `
      <div class="compare-grid">
        ${diffBanner}
        ${renderCompareColumn(p1)}
        ${renderCompareColumn(p2)}
      </div>
    `;

    compareModal.style.display = 'flex';
  }

  function renderCompareColumn(p) {
    const isAmazon = p.source === 'amazon';
    return `
      <div class="compare-col">
        <span class="store-pill-mini ${isAmazon ? 'mini-amazon' : 'mini-flipkart'}" style="align-self:flex-start;">
          ${isAmazon ? 'Amazon India' : 'Flipkart'}
        </span>
        <div style="height:120px;display:flex;align-items:center;justify-content:center;">
          <img src="${escapeHtml(p.image || '')}" alt="" style="max-height:100%;max-width:100%;object-fit:contain;">
        </div>
        <h4 style="font-size:0.95rem;line-height:1.4;">${escapeHtml(p.title)}</h4>
        <div style="font-size:1.5rem;font-weight:800;color:var(--text-main);">
          ${p.price ? inrFormatter.format(p.price) : 'Check Site'}
        </div>
        <div style="font-size:0.82rem;color:var(--text-muted);">
          ⭐ Rating: <strong>${p.rating ? p.rating.toFixed(1) + ' / 5' : 'Not rated'}</strong>
        </div>
        <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" class="btn-card-buy ${isAmazon ? 'buy-amz' : 'buy-flp'}" style="margin-top:auto;justify-content:center;">
          View on ${isAmazon ? 'Amazon' : 'Flipkart'} ↗
        </a>
      </div>
    `;
  }

  function closeCompareModal() {
    compareModal.style.display = 'none';
  }

  // Reset Filters
  function resetFilters() {
    state.filters = {
      sort: '',
      minPrice: null,
      maxPrice: null,
      dealsOnly: false,
      ratedFour: false,
      strictMode: true,
    };
    sortSelect.value = '';
    if (pillStrict) pillStrict.classList.add('active');
    pillDeals.classList.remove('active');
    pillFourStar.classList.remove('active');
    pillUnder10k.classList.remove('active');
    pillUnder50k.classList.remove('active');
    renderResults();
    showToast('Filters reset');
  }

  // Helper States
  function showLoading() {
    emptyState.style.display = 'none';
    splitViewContainer.style.display = 'none';
    mergedGridContainer.style.display = 'none';
    loadingState.style.display = 'flex';
  }

  function showEmpty(title, desc) {
    loadingState.style.display = 'none';
    splitViewContainer.style.display = 'none';
    mergedGridContainer.style.display = 'none';
    emptyState.style.display = 'block';
    document.getElementById('empty-title').textContent = title;
    document.getElementById('empty-desc').textContent = desc;
  }

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    toastCenter.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.25s ease';
      setTimeout(() => toast.remove(), 250);
    }, 2800);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
