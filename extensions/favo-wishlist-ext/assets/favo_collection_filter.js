(function() {
    document.addEventListener("DOMContentLoaded", function() {
      const sidebarRoot = document.getElementById("favo-collection-filter-root");
      if (!sidebarRoot) return;

      // Relocate sidebar filter to be next to the product grid (aligned inside page margins)
      let gridContainer = document.querySelector(".collection-wrapper, #ProductGridContainer .collection, #ProductGridContainer .page-width, .product-grid-container .page-width, .collection.page-width");
      if (!gridContainer) {
        gridContainer = document.querySelector("#ProductGridContainer, .product-grid-container, .collection-grid, .collection");
        if (gridContainer) {
          const innerPageWidth = gridContainer.querySelector(".page-width, .collection");
          if (innerPageWidth) {
            gridContainer = innerPageWidth;
          }
        }
      }

      if (gridContainer) {
        gridContainer.classList.add("favo-collection-container-flex");
        gridContainer.insertBefore(sidebarRoot, gridContainer.firstChild);
        
        // Add stretch class to all siblings of the sidebar inside the flex container
        for (let child of gridContainer.children) {
          if (child !== sidebarRoot) {
            child.classList.add("favo-collection-grid-right");
          }
        }

        // Create and insert mobile filter trigger button
        const mobileTrigger = document.createElement("button");
        mobileTrigger.type = "button";
        mobileTrigger.className = "favo-filter-trigger-btn";
        mobileTrigger.id = "favo-filter-mobile-trigger";
        mobileTrigger.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
            <path d="M228.06,49.62A8,8,0,0,0,224,48H32a8,8,0,0,0-6.06,13.22L96,139.17V208a8,8,0,0,0,3.24,6.48l32,24A8,8,0,0,0,144,232V139.17l70.06-77.95A8,8,0,0,0,228.06,49.62ZM128,128a8,8,0,0,0-2.06,5.22V211.83l-16-12V133.22A8,8,0,0,0,107.88,128L47.53,64H208.47Z"></path>
          </svg>
          Filters
        `;
        gridContainer.insertBefore(mobileTrigger, sidebarRoot);

        // Create overlay and insert to body
        const overlay = document.createElement("div");
        overlay.className = "favo-filter-overlay";
        overlay.id = "favo-filter-overlay";
        document.body.appendChild(overlay);

        // Toggle drawer function
        function toggleDrawer(show) {
          if (show) {
            sidebarRoot.classList.add("active");
            overlay.classList.add("active");
            document.body.style.overflow = "hidden"; // Prevent background scrolling
          } else {
            sidebarRoot.classList.remove("active");
            overlay.classList.remove("active");
            document.body.style.overflow = "";
          }
        }

        // Event listeners
        mobileTrigger.addEventListener("click", () => toggleDrawer(true));
        overlay.addEventListener("click", () => toggleDrawer(false));
        
        const closeBtn = document.getElementById("favo-filter-close-btn");
        if (closeBtn) closeBtn.addEventListener("click", () => toggleDrawer(false));
        
        const applyBtn = document.getElementById("favo-filter-apply-btn");
        if (applyBtn) applyBtn.addEventListener("click", () => toggleDrawer(false));
      }

      const collectionHandle = sidebarRoot.dataset.collectionHandle;
      if (!collectionHandle) return;

      const accordionContainer = document.getElementById("favo-filter-accordions");
      const clearAllBtn = document.getElementById("favo-filter-clear-all");

      // Global state
      let allProducts = [];
      let activeFilters = {
        vendors: new Set(),
        categories: new Set(),
        apparelSizes: new Set(),
        shirtSizes: new Set(),
        bottomsSizes: new Set(),
        shoeSizes: new Set(),
        swimSizes: new Set(),
        accessoriesSizes: new Set(),
        minPrice: null,
        maxPrice: null
      };

      let minPriceLimit = 0;
      let maxPriceLimit = 100000;

      // Determine page status
      const collectionTitle = "{{ collection.title | escape }}".toLowerCase().trim();
      const isBrandPage = collectionTitle.includes("sandro") || 
                          collectionTitle.includes("gucci") || 
                          collectionTitle.includes("missoni") || 
                          collectionTitle.includes("tom ford") || 
                          collectionTitle.includes("givenchy") || 
                          collectionTitle.includes("bally") ||
                          collectionTitle.includes("thom browne");

      // Size Classifier Utility
      function classifySize(value, productType, productTags) {
        const val = value.trim();
        const type = (productType || '').toLowerCase();
        const tagsStr = (productTags || []).join(',').toLowerCase();

        // 1. Shoe Size
        if (type.includes('shoe') || type.includes('footwear') || tagsStr.includes('shoe') || tagsStr.includes('footwear')) {
          return 'shoeSizes';
        }

        // 2. Swim & Intimates
        if (type.includes('swim') || type.includes('intimates') || type.includes('underwear') || tagsStr.includes('swim') || tagsStr.includes('intimates')) {
          return 'swimSizes';
        }

        // 3. Shirt Size (Alphabetic)
        const shirtRegex = /^(xxs|xs|s|m|l|xl|xxl|2xl|3xl|4xl|os|one size|onesize)$/i;
        if (shirtRegex.test(val)) {
          return 'shirtSizes';
        }

        // 4. Bottoms Size
        const bottomsKeywords = ['pant', 'trouser', 'bottom', 'jean', 'short', 'skirt'];
        const isBottom = bottomsKeywords.some(kw => type.includes(kw) || tagsStr.includes(kw));
        
        // Check if numeric
        const isNumeric = !isNaN(val) || /^\d+\/\d+(\.\d+)?$/.test(val);
        if (isNumeric) {
          if (isBottom) {
            return 'bottomsSizes';
          }
          return 'apparelSizes';
        }

        return 'accessoriesSizes';
      }

      // Fetch products from Shopify AJAX API
      fetch(`/collections/${collectionHandle}/products.json?limit=250`)
        .then(res => res.json())
        .then(data => {
          if (data && data.products) {
            allProducts = data.products;
            initializeFilters();
          }
        })
        .catch(err => console.error("[FAVO Filter] Error loading products:", err));

      function initializeFilters() {
        // Compute option groups and range limits
        const vendors = {};
        const categories = {};
        const apparelSizes = {};
        const shirtSizes = {};
        const bottomsSizes = {};
        const shoeSizes = {};
        const swimSizes = {};
        const accessoriesSizes = {};

        let minPrice = Infinity;
        let maxPrice = -Infinity;

        allProducts.forEach(product => {
          // Vendor
          if (product.vendor) {
            vendors[product.vendor] = (vendors[product.vendor] || 0) + 1;
          }
          // Category (Product Type)
          if (product.product_type) {
            categories[product.product_type] = (categories[product.product_type] || 0) + 1;
          }

          // Price boundaries
          product.variants.forEach(variant => {
            const price = parseFloat(variant.price);
            if (!isNaN(price)) {
              if (price < minPrice) minPrice = price;
              if (price > maxPrice) maxPrice = price;
            }
          });

          // Variant option sizes
          product.options.forEach((opt, idx) => {
            const name = opt.name.toLowerCase();
            if (name.includes('size') || name.includes('taille') || name.includes('talla')) {
              const optionKey = `option${idx + 1}`;
              
              // Get all unique sizes for variants
              const sizesAdded = new Set();
              product.variants.forEach(v => {
                const sizeVal = v[optionKey];
                if (sizeVal && !sizesAdded.has(sizeVal)) {
                  sizesAdded.add(sizeVal);
                  const group = classifySize(sizeVal, product.product_type, product.tags);
                  
                  if (group === 'apparelSizes') apparelSizes[sizeVal] = (apparelSizes[sizeVal] || 0) + 1;
                  else if (group === 'shirtSizes') shirtSizes[sizeVal] = (shirtSizes[sizeVal] || 0) + 1;
                  else if (group === 'bottomsSizes') bottomsSizes[sizeVal] = (bottomsSizes[sizeVal] || 0) + 1;
                  else if (group === 'shoeSizes') shoeSizes[sizeVal] = (shoeSizes[sizeVal] || 0) + 1;
                  else if (group === 'swimSizes') swimSizes[sizeVal] = (swimSizes[sizeVal] || 0) + 1;
                  else accessoriesSizes[sizeVal] = (accessoriesSizes[sizeVal] || 0) + 1;
                }
              });
            }
          });
        });

        // Set limits
        minPriceLimit = minPrice === Infinity ? 0 : Math.floor(minPrice);
        maxPriceLimit = maxPrice === -Infinity ? 1000 : Math.ceil(maxPrice);
        activeFilters.minPrice = minPriceLimit;
        activeFilters.maxPrice = maxPriceLimit;

        // Render accordion panels
        renderAccordions({
          vendors,
          categories,
          apparelSizes,
          shirtSizes,
          bottomsSizes,
          shoeSizes,
          swimSizes,
          accessoriesSizes
        });
      }

      function renderAccordions(groups) {
        accordionContainer.innerHTML = '';

        // Helper to generate checkbox html
        function makeOptionsListHTML(optGroup, stateKey) {
          const sorted = Object.entries(optGroup).sort((a, b) => b[1] - a[1]);
          if (sorted.length === 0) return '';

          let html = `<div class="favo-filter-options-list" data-state-key="${stateKey}">`;
          sorted.forEach(([name, count]) => {
            html += `
              <label class="favo-filter-option-row">
                <input type="checkbox" class="favo-filter-checkbox" value="${name}" />
                <span class="favo-filter-option-label">
                  ${name} <span class="favo-filter-option-count">(${count})</span>
                </span>
              </label>
            `;
          });
          html += '</div>';

          // Search bar wrapper if options are more than 5
          let searchHTML = '';
          if (sorted.length > 5) {
            searchHTML = `
              <div class="favo-filter-search-wrapper">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                  <path d="M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"></path>
                </svg>
                <input type="search" placeholder="Search filters" class="favo-filter-search-input" />
              </div>
            `;
          }

          return searchHTML + html;
        }

        // Accordion item builder
        function addAccordionItem(title, contentHTML, visible = true) {
          if (!contentHTML || !visible) return;

          const item = document.createElement("div");
          item.className = "favo-filter-accordion-item";
          item.innerHTML = `
            <button type="button" class="favo-filter-accordion-header active">
              <span>${title}</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80a8,8,0,0,1,11.32-11.32L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"></path>
              </svg>
            </button>
            <div class="favo-filter-accordion-content active">
              ${contentHTML}
            </div>
          `;
          accordionContainer.appendChild(item);
        }

        // 1. Designer (Hide if brand page)
        const designerHTML = makeOptionsListHTML(groups.vendors, 'vendors');
        addAccordionItem("Designer", designerHTML, !isBrandPage);

        // 2. Price
        const priceHTML = `
          <div class="favo-filter-price-inputs">
            <div class="favo-filter-price-field">
              <span>$</span>
              <input type="number" class="favo-filter-price-input" id="favo-price-min" min="${minPriceLimit}" max="${maxPriceLimit}" placeholder="${minPriceLimit}" value="${minPriceLimit}" />
            </div>
            <span class="favo-filter-price-separator">–</span>
            <div class="favo-filter-price-field">
              <span>$</span>
              <input type="number" class="favo-filter-price-input" id="favo-price-max" min="${minPriceLimit}" max="${maxPriceLimit}" placeholder="${maxPriceLimit}" value="${maxPriceLimit}" />
            </div>
          </div>
        `;
        addAccordionItem("Price", priceHTML, true);

        // 3. Apparel Size
        const apparelHTML = makeOptionsListHTML(groups.apparelSizes, 'apparelSizes');
        addAccordionItem("Apparel Size", apparelHTML);

        // 4. Bottoms Size
        const bottomsHTML = makeOptionsListHTML(groups.bottomsSizes, 'bottomsSizes');
        addAccordionItem("Bottoms Size", bottomsHTML);

        // 5. Shirt Size
        const shirtHTML = makeOptionsListHTML(groups.shirtSizes, 'shirtSizes');
        addAccordionItem("Shirt Size", shirtHTML);

        // 6. Shoe Size
        const shoeHTML = makeOptionsListHTML(groups.shoeSizes, 'shoeSizes');
        addAccordionItem("Shoe Size", shoeHTML);

        // 7. Swim & Intimates Size
        const swimHTML = makeOptionsListHTML(groups.swimSizes, 'swimSizes');
        addAccordionItem("Swim & Intimates Size", swimHTML);

        // 8. Accessories Size
        const accHTML = makeOptionsListHTML(groups.accessoriesSizes, 'accessoriesSizes');
        addAccordionItem("Accessories Size", accHTML);

        // 9. Category
        const categoryHTML = makeOptionsListHTML(groups.categories, 'categories');
        addAccordionItem("Category", categoryHTML);

        bindEvents();
      }

      function bindEvents() {
        // Accordion Toggle
        const headers = accordionContainer.querySelectorAll(".favo-filter-accordion-header");
        headers.forEach(header => {
          header.addEventListener("click", function() {
            const content = this.nextElementSibling;
            this.classList.toggle("active");
            content.classList.toggle("active");
          });
        });

        // Search options
        const searchInputs = accordionContainer.querySelectorAll(".favo-filter-search-input");
        searchInputs.forEach(input => {
          input.addEventListener("input", function() {
            const query = this.value.toLowerCase().trim();
            const list = this.parentElement.nextElementSibling;
            const rows = list.querySelectorAll(".favo-filter-option-row");
            rows.forEach(row => {
              const label = row.querySelector(".favo-filter-option-label").textContent.toLowerCase();
              if (label.includes(query)) {
                row.classList.remove("favo-filter-hidden");
              } else {
                row.classList.add("favo-filter-hidden");
              }
            });
          });
        });

        // Checkbox filtering
        const checkboxes = accordionContainer.querySelectorAll(".favo-filter-checkbox");
        checkboxes.forEach(cb => {
          cb.addEventListener("change", function() {
            const key = this.closest(".favo-filter-options-list").dataset.stateKey;
            const val = this.value;

            if (this.checked) {
              activeFilters[key].add(val);
            } else {
              activeFilters[key].delete(val);
            }
            applyFilters();
          });
        });

        // Price Input filtering
        const minInput = document.getElementById("favo-price-min");
        const maxInput = document.getElementById("favo-price-max");

        if (minInput && maxInput) {
          const handlePriceChange = () => {
            const minVal = parseFloat(minInput.value);
            const maxVal = parseFloat(maxInput.value);
            activeFilters.minPrice = isNaN(minVal) ? minPriceLimit : minVal;
            activeFilters.maxPrice = isNaN(maxVal) ? maxPriceLimit : maxVal;
            applyFilters();
          };

          minInput.addEventListener("change", handlePriceChange);
          maxInput.addEventListener("change", handlePriceChange);
        }
      }

      // Re-usable Helper to parse handles from product DOM elements
      function getProductHandleFromCard(card) {
        if (card.dataset.productHandle) return card.dataset.productHandle;
        
        // Find first link containing /products/
        const links = card.querySelectorAll('a[href*="/products/"]');
        for (let link of links) {
          try {
            const urlPath = new URL(link.href).pathname;
            const match = urlPath.match(/\/products\/([a-zA-Z0-9\-_]+)/);
            if (match) return match[1];
          } catch(e) {}
        }
        return null;
      }

      function applyFilters() {
        // Collect visible product handles based on filter parameters
        const visibleHandles = new Set();

        allProducts.forEach(product => {
          // 1. Vendor
          if (activeFilters.vendors.size > 0 && !activeFilters.vendors.has(product.vendor)) {
            return;
          }
          // 2. Category
          if (activeFilters.categories.size > 0 && !activeFilters.categories.has(product.product_type)) {
            return;
          }

          // 3. Price range verification
          let inPriceRange = false;
          product.variants.forEach(variant => {
            const price = parseFloat(variant.price);
            if (!isNaN(price)) {
              if (price >= activeFilters.minPrice && price <= activeFilters.maxPrice) {
                inPriceRange = true;
              }
            }
          });
          if (!inPriceRange) return;

          // 4. Variant Size Filters (Shirt, Apparel, Bottoms, Shoe, Swim, Accessories)
          const sizeFilters = [
            { set: activeFilters.apparelSizes, key: 'apparelSizes' },
            { set: activeFilters.shirtSizes, key: 'shirtSizes' },
            { set: activeFilters.bottomsSizes, key: 'bottomsSizes' },
            { set: activeFilters.shoeSizes, key: 'shoeSizes' },
            { set: activeFilters.swimSizes, key: 'swimSizes' },
            { set: activeFilters.accessoriesSizes, key: 'accessoriesSizes' }
          ];

          // Check if any size filter categories are active
          const activeSizeCategories = sizeFilters.filter(f => f.set.size > 0);
          if (activeSizeCategories.length > 0) {
            let matchedSize = false;

            product.variants.forEach(variant => {
              product.options.forEach((opt, idx) => {
                const name = opt.name.toLowerCase();
                if (name.includes('size') || name.includes('taille') || name.includes('talla')) {
                  const optionKey = `option${idx + 1}`;
                  const sizeVal = variant[optionKey];
                  
                  if (sizeVal) {
                    const group = classifySize(sizeVal, product.product_type, product.tags);
                    
                    activeSizeCategories.forEach(f => {
                      if (f.key === group && f.set.has(sizeVal)) {
                        matchedSize = true;
                      }
                    });
                  }
                }
              });
            });

            if (!matchedSize) return;
          }

          visibleHandles.add(product.handle);
        });

        // Toggle DOM elements
        const cardSelectors = [
          '.product-grid .grid__item',
          '.product-grid-container .card-wrapper',
          '[class*="product-card"]',
          '.grid__item',
          '.card-wrapper'
        ];

        let matchedCards = false;

        cardSelectors.forEach(selector => {
          const cards = document.querySelectorAll(selector);
          if (cards.length > 0) {
            matchedCards = true;
            cards.forEach(card => {
              const handle = getProductHandleFromCard(card);
              if (handle) {
                if (visibleHandles.has(handle)) {
                  card.classList.remove("favo-filter-hidden");
                } else {
                  card.classList.add("favo-filter-hidden");
                }
              }
            });
          }
        });

        // Fallback: If no cards are found, scan all links to find grid wrappers
        if (!matchedCards) {
          const allLinks = document.querySelectorAll('a[href*="/products/"]');
          const visitedParents = new Set();
          allLinks.forEach(link => {
            const card = link.closest('li, div[class*="item"], div[class*="card"]');
            if (card && !visitedParents.has(card)) {
              visitedParents.add(card);
              const handle = getProductHandleFromCard(card);
              if (handle) {
                if (visibleHandles.has(handle)) {
                  card.classList.remove("favo-filter-hidden");
                } else {
                  card.classList.add("favo-filter-hidden");
                }
              }
            }
          });
        }
      }

      // Clear all handler
      clearAllBtn.addEventListener("click", function() {
        const checkboxes = accordionContainer.querySelectorAll(".favo-filter-checkbox");
        checkboxes.forEach(cb => cb.checked = false);

        activeFilters.vendors.clear();
        activeFilters.categories.clear();
        activeFilters.apparelSizes.clear();
        activeFilters.shirtSizes.clear();
        activeFilters.bottomsSizes.clear();
        activeFilters.shoeSizes.clear();
        activeFilters.swimSizes.clear();
        activeFilters.accessoriesSizes.clear();

        const minInput = document.getElementById("favo-price-min");
        const maxInput = document.getElementById("favo-price-max");
        if (minInput && maxInput) {
          minInput.value = minPriceLimit;
          maxInput.value = maxPriceLimit;
        }
        activeFilters.minPrice = minPriceLimit;
        activeFilters.maxPrice = maxPriceLimit;

        applyFilters();
      });

    });
  })();