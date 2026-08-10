(function () {
  const LOCAL_KEY = "favo_wishlist";
  const PROXY = "/apps/favo-wishlist";
  let state = [];
  let isCustomer = false;
  let customerId = "";
  let shop = "";

  // Dynamic Toast popup system
  function showToast(message) {
    let container = document.querySelector(".favo-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "favo-toast-container";
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = "favo-toast";
    toast.innerHTML = message;
    container.appendChild(toast);

    setTimeout(() => toast.classList.add("is-show"), 10);

    setTimeout(() => {
      toast.classList.remove("is-show");
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  function getLocal() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || []; } 
    catch (e) { return []; }
  }

  function setLocal(list) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  }

  async function init() {
    // 1. Scan/inject headers and grids on load
    injectHeaderHeart();
    injectCardHearts();

    const el = document.querySelector(".favo-wishlist-btn-wrapper, .favo-wishlist-page-container, .favo-card-heart-btn");
    if (!el) {
      // Even if wrapper is not present, we want to fetch state to sync the header heart badge count!
      customerId = "";
      isCustomer = false;
      shop = window.Shopify?.shop || "";
      state = getLocal();
      updateButtons();
      observeDynamicGrids();
      return;
    }

    customerId = el.getAttribute("data-customer-id") || "";
    isCustomer = customerId !== "";
    shop = el.getAttribute("data-shop") || window.Shopify?.shop || "";

    if (isCustomer) {
      const local = getLocal();
      if (local.length > 0) await syncLocal(local);
      await fetchWishlist();
    } else {
      state = getLocal();
      updateButtons();
      renderPage();
    }
    setupEvents();
    observeDynamicGrids();
  }

  async function syncLocal(items) {
    try {
      const res = await fetch(`${PROXY}?shop=${shop}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sync",
          items: items.map(i => ({ productId: i.productId }))
        })
      });
      const data = await res.json();
      if (data.success) localStorage.removeItem(LOCAL_KEY);
    } catch (e) {
      console.warn("[Favo Wishlist] Sync failed, keeping local items:", e);
    }
  }

  async function fetchWishlist() {
    const isPage = document.querySelector(".favo-wishlist-page-container") !== null;
    try {
      const res = await fetch(`${PROXY}?shop=${shop}${isPage ? "&full=true" : ""}`);
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      
      const data = await res.json();
      if (data.success) {
        state = data.wishlist || [];
      } else {
        throw new Error(data.error || "Failed loading");
      }
    } catch (e) {
      console.warn("[Favo Wishlist] Proxy fetch failed. Falling back to local storage:", e);
      state = getLocal(); 
    }
    updateButtons();
    renderPage();
  }

  function updateButtons() {
    // 1. Update primary wishlist buttons
    document.querySelectorAll(".favo-wishlist-btn-wrapper").forEach(wrapper => {
      const productId = wrapper.getAttribute("data-product-id");
      const button = wrapper.querySelector(".favo-wishlist-btn");
      const btnText = wrapper.querySelector(".favo-btn-text");
      const addText = wrapper.getAttribute("data-btn-text-add") || "Add to Wishlist";
      const removeText = wrapper.getAttribute("data-btn-text-remove") || "Remove from Wishlist";
      
      const isSaved = state.some(i => i.productId === productId);
      if (button) {
        if (isSaved) {
          button.classList.add("is-active");
          if (btnText) btnText.textContent = removeText;
        } else {
          button.classList.remove("is-active");
          if (btnText) btnText.textContent = addText;
        }
      }
    });

    // 2. Update card heart buttons (inject overlay)
    document.querySelectorAll(".favo-card-heart-btn").forEach(btn => {
      const productId = btn.getAttribute("data-product-id");
      const handle = btn.getAttribute("data-product-handle");
      const isSaved = state.some(i => i.productId === productId || i.handle === handle);
      
      if (isSaved) {
        btn.classList.add("is-active");
      } else {
        btn.classList.remove("is-active");
      }
    });

    // 3. Update header counter badge
    document.querySelectorAll(".favo-header-heart-count").forEach(countSpan => {
      countSpan.textContent = state.length;
      if (state.length > 0) {
        countSpan.classList.remove("favo-hidden");
      } else {
        countSpan.classList.add("favo-hidden");
      }
    });
  }

  function setupEvents() {
    document.body.addEventListener("click", function (e) {
      // Toggle from main product page button
      const button = e.target.closest(".favo-wishlist-btn");
      if (button) {
        const wrapper = button.closest(".favo-wishlist-btn-wrapper");
        if (wrapper) {
          e.preventDefault();
          handleToggleAction(wrapper);
        }
        return;
      }

      // Toggle from grid card heart button
      const cardHeart = e.target.closest(".favo-card-heart-btn");
      if (cardHeart) {
        e.preventDefault();
        handleToggleAction(cardHeart);
        return;
      }
    });
  }

  async function handleToggleAction(el) {
    const productId = el.getAttribute("data-product-id");
    const title = el.getAttribute("data-product-title");
    const handle = el.getAttribute("data-product-handle");
    const imageUrl = el.getAttribute("data-product-img");
    const price = el.getAttribute("data-product-price");
    const currency = el.getAttribute("data-product-currency") || "EGP";

    if (!productId) return;

    const isSaved = state.some(i => i.productId === productId);
    const item = { productId, title, handle, imageUrl, price, currencyCode: currency, availableForSale: true };
    
    // --- OPTIMISTIC UI UPDATE ---
    if (isSaved) {
      state = state.filter(i => i.productId !== productId);
      showToast("🤍 Removed from Wishlist");
    } else {
      state.push(item);
      showToast("🖤 Added to Wishlist");
    }

    setLocal(state);

    updateButtons();
    renderPage();

    // --- ASYNC BACKGROUND SYNC ---
    if (isCustomer) {
      try {
        const res = await fetch(`${PROXY}?shop=${shop}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: isSaved ? "delete" : "add",
            productId: productId
          })
        });
        const data = await res.json();
        if (!data.success) {
          throw new Error(data.error || "Sync fail");
        }
      } catch (err) {
        console.warn("[Favo Wishlist] Background sync failed:", err);
      }
    } else {
      setLocal(state);
    }
  }

  function getProductGender(item) {
    const text = `${item.title} ${item.handle} ${item.vendor || ""}`.toLowerCase();
    let isWomen = false;
    let isMen = false;

    if (text.includes("women") || text.includes("dress") || text.includes("skirt") || text.includes("girl") || text.includes("pink") || text.includes("woman") || text.includes("lady")) {
      isWomen = true;
    }
    if (text.includes("men") || text.includes("boy") || text.includes("man") || text.includes("unisex")) {
      isMen = true;
    }

    // Default to both if undetermined
    if (!isWomen && !isMen) {
      isWomen = true;
      isMen = true;
    }

    return { isWomen, isMen };
  }

  function renderPage() {
    const pageContainer = document.querySelector(".favo-wishlist-page-container");
    if (!pageContainer) return;

    initFilters();

    const grid = document.getElementById("favo-wishlist-grid");
    const emptyState = document.getElementById("favo-wishlist-empty");
    const loadingState = pageContainer.querySelector(".favo-wishlist-loading");
    const countSpan = document.getElementById("favo-wishlist-count");

    if (loadingState) loadingState.classList.add("favo-hidden");

    // 1. Apply Filtering
    // A. Stock Status
    const activeTabEl = pageContainer.querySelector(".favo-tab-btn.is-active");
    const activeTab = activeTabEl ? activeTabEl.getAttribute("data-tab") : "in-stock";
    
    // B. Gender Filters
    const checkedGenders = Array.from(pageContainer.querySelectorAll(".favo-filter-checkbox:checked")).map(cb => cb.value);

    let filtered = state.filter(item => {
      // Stock Status Check
      if (activeTab === "in-stock") {
        if (item.availableForSale === false) return false;
      } else if (activeTab === "sold-out") {
        if (item.availableForSale !== false) return false;
      }
      
      // Gender Check
      const gender = getProductGender(item);
      const matchesWomen = checkedGenders.includes("women") && gender.isWomen;
      const matchesMen = checkedGenders.includes("men") && gender.isMen;
      
      return matchesWomen || matchesMen;
    });

    // 2. Apply Sorting
    const sortSelect = document.getElementById("favo-wishlist-sort-select");
    const sortVal = sortSelect ? sortSelect.value : "recent";

    if (sortVal === "price-asc") {
      filtered.sort((a, b) => parseFloat(a.price || 0) - parseFloat(b.price || 0));
    } else if (sortVal === "price-desc") {
      filtered.sort((a, b) => parseFloat(b.price || 0) - parseFloat(a.price || 0));
    }

    if (countSpan) countSpan.textContent = filtered.length;

    if (filtered.length === 0) {
      if (grid) grid.classList.add("favo-hidden");
      if (emptyState) emptyState.classList.remove("favo-hidden");
      return;
    }

    if (emptyState) emptyState.classList.add("favo-hidden");
    if (grid) {
      grid.innerHTML = "";
      grid.classList.remove("favo-hidden");

      filtered.forEach(item => {
        const card = document.createElement("div");
        card.className = "favo-product-card";
        card.setAttribute("data-product-id", item.productId);

        // Price calculations
        let priceHtml = "";
        const priceNum = parseFloat(item.price || 0);
        const compareNum = item.compareAtPrice ? parseFloat(item.compareAtPrice) : 0;
        
        if (compareNum > priceNum) {
          const discount = Math.round(((compareNum - priceNum) / compareNum) * 100);
          priceHtml = `
            <span class="favo-price-sale">${item.price} ${item.currencyCode || ""}</span>
            <span class="favo-price-compare">${item.compareAtPrice} ${item.currencyCode || ""}</span>
            <span class="favo-price-discount">-${discount}%</span>
          `;
        } else {
          priceHtml = `<span class="favo-price-sale">${item.price || "0.00"} ${item.currencyCode || ""}</span>`;
        }

        card.innerHTML = `
          <button type="button" class="favo-remove-btn" aria-label="Remove item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
          <a href="/products/${item.handle}" class="favo-product-image-link">
            <img src="${item.imageUrl}" class="favo-product-img" alt="${item.title}" loading="lazy" />
          </a>
          <div class="favo-product-info">
            <h4 class="favo-product-brand">${item.vendor || "FLÙPI"}</h4>
            <a href="/products/${item.handle}" class="favo-product-title-link">
              <p class="favo-product-title">${item.title}</p>
            </a>
            <div class="favo-product-size">Size: One Size</div>
            <div class="favo-product-prices">
              ${priceHtml}
            </div>
            <form action="/cart/add" method="post" class="favo-add-to-cart-form">
              <input type="hidden" name="id" value="${item.variantId || ""}" />
              <button type="submit" class="favo-add-to-cart-btn">Add to Bag</button>
            </form>
          </div>
        `;

        // Remove item button event
        const removeBtn = card.querySelector(".favo-remove-btn");
        removeBtn.addEventListener("click", function (e) {
          e.preventDefault();
          handleToggleAction(card);
        });

        grid.appendChild(card);
      });
    }
  }

  let filtersInitialized = false;
  function initFilters() {
    if (filtersInitialized) return;

    // A. Tabs clicks
    document.querySelectorAll(".favo-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".favo-tab-btn").forEach(b => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        renderPage();
      });
    });

    // B. Checkbox changes
    document.querySelectorAll(".favo-filter-checkbox").forEach(chk => {
      chk.addEventListener("change", () => {
        renderPage();
      });
    });

    // C. Sort selection change
    const sortSelect = document.getElementById("favo-wishlist-sort-select");
    if (sortSelect) {
      sortSelect.addEventListener("change", () => {
        renderPage();
      });
    }

    filtersInitialized = true;
  }

  // Inject Heart icons onto standard product card images globally
  function injectCardHearts() {
    // 1. Precise Scan via helper triggers
    document.querySelectorAll(".favo-card-wishlist-trigger").forEach(trigger => {
      const card = trigger.closest(".card-wrapper, .product-card, .grid-view-item, .card, li, div");
      if (!card || card.querySelector(".favo-card-heart-btn")) return;

      const productId = trigger.getAttribute("data-product-id");
      const title = trigger.getAttribute("data-product-title");
      const handle = trigger.getAttribute("data-product-handle");
      const imageUrl = trigger.getAttribute("data-product-img");
      const price = trigger.getAttribute("data-product-price");
      const currency = trigger.getAttribute("data-product-currency") || "EGP";

      const imgContainer = card.querySelector(".media, .card__media, .product-card__image, .image-bar__item, a");
      if (imgContainer) {
        createHeartBtn(imgContainer, productId, title, handle, imageUrl, price, currency);
      }
    });

    // 2. Fallback Scan (Auto-detection for popular Dawn/Vite theme classes)
    const cardSelectors = [".card-wrapper", ".product-card", ".card--product", ".grid-view-item"];
    cardSelectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(card => {
        if (card.querySelector(".favo-card-heart-btn") || card.querySelector(".favo-card-wishlist-trigger")) return;

        const link = card.querySelector('a[href*="/products/"]');
        if (!link) return;
        const href = link.getAttribute("href");
        const parts = href.split("/products/");
        if (parts.length < 2) return;
        const handle = parts[1].split("?")[0];

        let productId = card.getAttribute("data-product-id") || "";
        if (!productId) {
          const input = card.querySelector('input[name="id"], input[name="product-id"], [data-product-id]');
          if (input) {
            productId = input.getAttribute("data-product-id") || input.value;
          }
        }
        if (!productId) return; // Need a product ID to wishlist

        const finalId = productId.toString().includes("Product/") ? productId : `gid://shopify/Product/${productId}`;

        const titleEl = card.querySelector(".card__heading, .product-card__title, h3, .title");
        const title = titleEl ? titleEl.textContent.trim() : "";

        const img = card.querySelector("img");
        const imageUrl = img ? img.getAttribute("src") : "";

        const priceEl = card.querySelector(".price, .product-card__price, .price-item, .price-sale");
        const price = priceEl ? priceEl.textContent.trim().replace(/[^0-9.]/g, "") : "";

        const imgContainer = card.querySelector(".media, .card__media, .product-card__image, a");
        if (imgContainer) {
          createHeartBtn(imgContainer, finalId, title, handle, imageUrl, price, "EGP");
        }
      });
    });
  }

  function createHeartBtn(container, productId, title, handle, imageUrl, price, currency) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "favo-card-heart-btn";
    btn.setAttribute("data-product-id", productId);
    btn.setAttribute("data-product-title", title);
    btn.setAttribute("data-product-handle", handle);
    btn.setAttribute("data-product-img", imageUrl);
    btn.setAttribute("data-product-price", price);
    btn.setAttribute("data-product-currency", currency);
    btn.setAttribute("aria-label", "Add to wishlist");

    btn.innerHTML = `
      <svg class="favo-heart-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
      </svg>
    `;

    const computedStyle = window.getComputedStyle(container);
    if (computedStyle.position === "static") {
      container.style.position = "relative";
    }

    container.appendChild(btn);
  }

  // Inject Heart Badge count navigation link in Store Header next to Cart
  function injectHeaderHeart() {
    if (document.querySelector(".favo-header-heart-link")) return;

    const cartLink = document.querySelector('a[href="/cart"], .header__icon--cart, #cart-icon-bubble');
    if (!cartLink) return;

    const heartLink = document.createElement("a");
    heartLink.href = "/pages/wishlist";
    heartLink.className = "favo-header-heart-link";
    heartLink.setAttribute("aria-label", "Wishlist");

    heartLink.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
      </svg>
      <span class="favo-header-heart-count favo-hidden">0</span>
    `;

    cartLink.parentNode.insertBefore(heartLink, cartLink);
  }

  // MutationObserver to scan dynamically loaded grids (Pagination, Filters)
  function observeDynamicGrids() {
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      mutations.forEach(m => {
        if (m.addedNodes.length > 0) shouldScan = true;
      });
      if (shouldScan) {
        injectCardHearts();
        updateButtons();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
