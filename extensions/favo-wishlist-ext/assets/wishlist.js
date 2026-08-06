/**
 * Favo Wishlist Storefront Controller
 */
(function () {
  const LOCAL_STORAGE_KEY = "favo_wishlist";
  const PROXY_PATH = "/apps/favo-wishlist";
  let wishlistState = [];
  let isCustomer = false;
  let customerId = "";
  let shopDomain = "";

  // Helper to fetch local storage items
  function getLocalWishlist() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  // Helper to set local storage items
  function setLocalWishlist(list) {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(list));
  }

  // Initialize wishlist state
  async function init() {
    // 1. Find wrapper details on page
    const wrapper = document.querySelector(".favo-wishlist-btn-wrapper, .favo-wishlist-page-container");
    if (!wrapper) return;

    customerId = wrapper.getAttribute("data-customer-id") || "";
    isCustomer = customerId !== "";
    shopDomain = wrapper.getAttribute("data-shop") || window.Shopify?.shop || "";

    if (isCustomer) {
      // User is logged in: sync local items first if any, then pull DB wishlist
      const localList = getLocalWishlist();
      if (localList.length > 0) {
        await syncLocalWishlist(localList);
      }
      await fetchUserWishlist();
    } else {
      // Guest: load from localStorage
      wishlistState = getLocalWishlist();
      updateStorefrontButtons();
      renderWishlistPage();
    }

    setupEventListeners();
  }

  // Sync guest items to database
  async function syncLocalWishlist(items) {
    try {
      const response = await fetch(`${PROXY_PATH}?shop=${shopDomain}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          action: "sync",
          items: items.map(item => ({
            productId: item.productId,
            variantId: item.variantId
          }))
        })
      });
      const data = await response.json();
      if (data.success) {
        // Clear local storage on successful sync
        localStorage.removeItem(LOCAL_STORAGE_KEY);
      }
    } catch (error) {
      console.error("[Favo Wishlist] Failed to sync local storage:", error);
    }
  }

  // Fetch logged in user's wishlist from DB
  async function fetchUserWishlist() {
    const isWishlistPage = document.querySelector(".favo-wishlist-page-container") !== null;
    const fetchUrl = `${PROXY_PATH}?shop=${shopDomain}${isWishlistPage ? "&full=true" : ""}`;

    try {
      const response = await fetch(fetchUrl);
      const data = await response.json();
      if (data.success) {
        wishlistState = data.wishlist || [];
        updateStorefrontButtons();
        renderWishlistPage();
      }
    } catch (error) {
      console.error("[Favo Wishlist] Failed to load customer wishlist:", error);
    }
  }

  // Update UI heart states of all product buttons matching current state
  function updateStorefrontButtons() {
    const buttons = document.querySelectorAll(".favo-wishlist-btn-wrapper");
    buttons.forEach(btnWrapper => {
      const productId = btnWrapper.getAttribute("data-product-id");
      const button = btnWrapper.querySelector(".favo-wishlist-btn");
      const btnText = btnWrapper.querySelector(".favo-btn-text");
      const addText = btnWrapper.getAttribute("data-btn-text-add") || "Add to Wishlist";
      const removeText = btnWrapper.getAttribute("data-btn-text-remove") || "Remove from Wishlist";
      
      const isSaved = wishlistState.some(item => item.productId === productId);
      
      if (isSaved) {
        button.classList.add("is-active");
        if (btnText) btnText.textContent = removeText;
      } else {
        button.classList.remove("is-active");
        if (btnText) btnText.textContent = addText;
      }
    });
  }

  // Set click listeners for buttons
  function setupEventListeners() {
    document.body.addEventListener("click", async function (event) {
      const button = event.target.closest(".favo-wishlist-btn");
      if (!button) return;

      const wrapper = button.closest(".favo-wishlist-btn-wrapper");
      if (!wrapper) return;

      event.preventDefault();
      button.disabled = true;

      const productId = wrapper.getAttribute("data-product-id");
      const title = wrapper.getAttribute("data-product-title");
      const handle = wrapper.getAttribute("data-product-handle");
      const imageUrl = wrapper.getAttribute("data-product-img");
      const price = wrapper.getAttribute("data-product-price");
      const currency = wrapper.getAttribute("data-product-currency");

      const isSaved = wishlistState.some(item => item.productId === productId);

      if (isSaved) {
        // REMOVE from wishlist
        if (isCustomer) {
          try {
            const response = await fetch(`${PROXY_PATH}?shop=${shopDomain}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "delete", productId })
            });
            const data = await response.json();
            if (data.success) {
              wishlistState = wishlistState.filter(item => item.productId !== productId);
            }
          } catch (e) {
            console.error("[Favo Wishlist] Failed to remove item:", e);
          }
        } else {
          wishlistState = wishlistState.filter(item => item.productId !== productId);
          setLocalWishlist(wishlistState);
        }
      } else {
        // ADD to wishlist
        const newItem = { productId, title, handle, imageUrl, price, currencyCode: currency };
        if (isCustomer) {
          try {
            const response = await fetch(`${PROXY_PATH}?shop=${shopDomain}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ productId })
            });
            const data = await response.json();
            if (data.success) {
              wishlistState.push(newItem);
            }
          } catch (e) {
            console.error("[Favo Wishlist] Failed to add item:", e);
          }
        } else {
          wishlistState.push(newItem);
          setLocalWishlist(wishlistState);
        }
      }

      updateStorefrontButtons();
      button.disabled = false;
    });
  }

  // Render wishlist page grid (runs if grid container is present)
  function renderWishlistPage() {
    const pageContainer = document.querySelector(".favo-wishlist-page-container");
    if (!pageContainer) return;

    const grid = document.getElementById("favo-wishlist-grid");
    const emptyState = document.getElementById("favo-wishlist-empty");
    const loadingState = pageContainer.querySelector(".favo-wishlist-loading");
    const countSpan = document.getElementById("favo-wishlist-count");
    const heartIconUrl = pageContainer.getAttribute("data-heart-icon-url") || "";

    if (loadingState) loadingState.classList.add("favo-hidden");

    if (countSpan) countSpan.textContent = wishlistState.length;

    if (wishlistState.length === 0) {
      if (grid) grid.classList.add("favo-hidden");
      if (emptyState) emptyState.classList.remove("favo-hidden");
      return;
    }

    if (emptyState) emptyState.classList.add("favo-hidden");
    if (grid) {
      grid.innerHTML = "";
      grid.classList.remove("favo-hidden");

      wishlistState.forEach(item => {
        const card = document.createElement("div");
        card.className = "favo-product-card";
        card.setAttribute("data-product-id", item.productId);

        const priceFormatted = item.price ? `${item.price} ${item.currencyCode || ""}` : "";

        card.innerHTML = `
          <button type="button" class="favo-remove-btn" aria-label="Remove item">
            <img src="${heartIconUrl}" class="favo-heart-img" alt="Remove" width="18" height="18" />
          </button>
          <a href="/products/${item.handle}" class="favo-product-image-link">
            <img src="${item.imageUrl}" class="favo-product-img" alt="${item.imageAlt || item.title}" loading="lazy" />
          </a>
          <div class="favo-product-info">
            <a href="/products/${item.handle}" class="favo-product-title-link">
              <h3 class="favo-product-title">${item.title}</h3>
            </a>
            <p class="favo-product-price">${priceFormatted}</p>
            <form action="/cart/add" method="post" class="favo-add-to-cart-form">
              <input type="hidden" name="id" value="${item.variantId || ""}" />
              <button type="submit" class="favo-add-to-cart-btn">Add to Cart</button>
            </form>
          </div>
        `;

        // Wire remove click handler for card
        const removeBtn = card.querySelector(".favo-remove-btn");
        removeBtn.addEventListener("click", async function (e) {
          e.preventDefault();
          removeBtn.disabled = true;

          if (isCustomer) {
            try {
              const response = await fetch(`${PROXY_PATH}?shop=${shopDomain}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "delete", productId: item.productId })
              });
              const data = await response.json();
              if (data.success) {
                wishlistState = wishlistState.filter(w => w.productId !== item.productId);
              }
            } catch (err) {
              console.error("[Favo Wishlist] Failed to delete item:", err);
            }
          } else {
            wishlistState = wishlistState.filter(w => w.productId !== item.productId);
            setLocalWishlist(wishlistState);
          }

          renderWishlistPage();
          updateStorefrontButtons();
        });

        grid.appendChild(card);
      });
    }
  }

  // Run initial loading on DOM ready or immediately if ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
