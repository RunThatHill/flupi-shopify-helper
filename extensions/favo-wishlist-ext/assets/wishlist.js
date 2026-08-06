(function () {
  const LOCAL_KEY = "favo_wishlist";
  const PROXY = "/apps/favo-wishlist";
  let state = [];
  let isCustomer = false;
  let customerId = "";
  let shop = "";

  function getLocal() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || []; } 
    catch (e) { return []; }
  }

  function setLocal(list) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  }

  async function init() {
    const el = document.querySelector(".favo-wishlist-btn-wrapper, .favo-wishlist-page-container");
    if (!el) return;

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
  }

  async function syncLocal(items) {
    try {
      const res = await fetch(`${PROXY}?shop=${shop}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sync",
          items: items.map(i => ({ productId: i.productId, variantId: i.variantId }))
        })
      });
      const data = await res.json();
      if (data.success) localStorage.removeItem(LOCAL_KEY);
    } catch (e) {
      console.error("[Favo] Sync failed:", e);
    }
  }

  async function fetchWishlist() {
    const isPage = document.querySelector(".favo-wishlist-page-container") !== null;
    try {
      const res = await fetch(`${PROXY}?shop=${shop}${isPage ? "&full=true" : ""}`);
      const data = await res.json();
      if (data.success) {
        state = data.wishlist || [];
        updateButtons();
        renderPage();
      }
    } catch (e) {
      console.error("[Favo] Load failed:", e);
    }
  }

  function updateButtons() {
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
  }

  function setupEvents() {
    document.body.addEventListener("click", async function (e) {
      const button = e.target.closest(".favo-wishlist-btn");
      if (!button) return;
      const wrapper = button.closest(".favo-wishlist-btn-wrapper");
      if (!wrapper) return;

      e.preventDefault();
      button.disabled = true;

      const productId = wrapper.getAttribute("data-product-id");
      const title = wrapper.getAttribute("data-product-title");
      const handle = wrapper.getAttribute("data-product-handle");
      const imageUrl = wrapper.getAttribute("data-product-img");
      const price = wrapper.getAttribute("data-product-price");
      const currency = wrapper.getAttribute("data-product-currency");

      const isSaved = state.some(i => i.productId === productId);

      if (isSaved) {
        if (isCustomer) {
          try {
            const res = await fetch(`${PROXY}?shop=${shop}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "delete", productId })
            });
            const data = await res.json();
            if (data.success) state = state.filter(i => i.productId !== productId);
          } catch (err) {
            console.error("[Favo] Remove failed:", err);
          }
        } else {
          state = state.filter(i => i.productId !== productId);
          setLocal(state);
        }
      } else {
        const item = { productId, title, handle, imageUrl, price, currencyCode: currency };
        if (isCustomer) {
          try {
            const res = await fetch(`${PROXY}?shop=${shop}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ productId })
            });
            const data = await res.json();
            if (data.success) state.push(item);
          } catch (err) {
            console.error("[Favo] Add failed:", err);
          }
        } else {
          state.push(item);
          setLocal(state);
        }
      }
      updateButtons();
      button.disabled = false;
    });
  }

  function renderPage() {
    const pageContainer = document.querySelector(".favo-wishlist-page-container");
    if (!pageContainer) return;

    const grid = document.getElementById("favo-wishlist-grid");
    const emptyState = document.getElementById("favo-wishlist-empty");
    const loadingState = pageContainer.querySelector(".favo-wishlist-loading");
    const countSpan = document.getElementById("favo-wishlist-count");
    const heartIconUrl = pageContainer.getAttribute("data-heart-icon-url") || "";

    if (loadingState) loadingState.classList.add("favo-hidden");
    if (countSpan) countSpan.textContent = state.length;

    if (state.length === 0) {
      if (grid) grid.classList.add("favo-hidden");
      if (emptyState) emptyState.classList.remove("favo-hidden");
      return;
    }

    if (emptyState) emptyState.classList.add("favo-hidden");
    if (grid) {
      grid.innerHTML = "";
      grid.classList.remove("favo-hidden");

      state.forEach(item => {
        const card = document.createElement("div");
        card.className = "favo-product-card";
        card.setAttribute("data-product-id", item.productId);

        const priceStr = item.price ? `${item.price} ${item.currencyCode || ""}` : "";

        card.innerHTML = `
          <button type="button" class="favo-remove-btn" aria-label="Remove item">
            <img src="${heartIconUrl}" class="favo-heart-img" alt="Remove" width="18" height="18" />
          </button>
          <a href="/products/${item.handle}" class="favo-product-image-link">
            <img src="${item.imageUrl}" class="favo-product-img" alt="${item.title}" loading="lazy" />
          </a>
          <div class="favo-product-info">
            <a href="/products/${item.handle}" class="favo-product-title-link">
              <h3 class="favo-product-title">${item.title}</h3>
            </a>
            <p class="favo-product-price">${priceStr}</p>
            <form action="/cart/add" method="post" class="favo-add-to-cart-form">
              <input type="hidden" name="id" value="${item.variantId || ""}" />
              <button type="submit" class="favo-add-to-cart-btn">Add to Cart</button>
            </form>
          </div>
        `;

        const removeBtn = card.querySelector(".favo-remove-btn");
        removeBtn.addEventListener("click", async function (e) {
          e.preventDefault();
          removeBtn.disabled = true;

          if (isCustomer) {
            try {
              const res = await fetch(`${PROXY}?shop=${shop}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "delete", productId: item.productId })
              });
              const data = await res.json();
              if (data.success) state = state.filter(w => w.productId !== item.productId);
            } catch (err) {
              console.error("[Favo] Delete failed:", err);
            }
          } else {
            state = state.filter(w => w.productId !== item.productId);
            setLocal(state);
          }

          renderPage();
          updateButtons();
        });

        grid.appendChild(card);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
