/**
 * services/hokaParser.js
 * ════════════════════════════════════════════════════════════
 * Normaliserer hoka.dk JSON API responses til stabilt, fladt format.
 *
 * Portet fra bontools/horkram/parser.js (ESM → CJS).
 * Bruges af routes/horkram.js til at returnere parsede data til frontend.
 * ════════════════════════════════════════════════════════════
 */

/**
 * Parse a single product from /api/catalog/products/{varenr}
 * @param {object} raw - Raw API response { Model: { ... } }
 * @returns {object} Normalized product data
 */
function parseProduct(raw) {
    const m = raw?.Model;
    if (!m) throw new Error('Ugyldigt produkt-svar: mangler Model');

    const nutrition = parseNutrition(m.Nutritions || []);

    const salesUnits = (m.SalesUnits?.Values || []).map(u => ({
        code: u.Code,
        name: u.TextSingular,
        namePlural: u.TextPlural,
        quantity: u.Quantity,
        listPrice: u.ListPrice,
        salesPrice: parseDanishNumber(u.FormattedPrices?.SalesPricePerBaseUnit),
        salesPricePerKg: parseDanishNumber(u.FormattedPrices?.SalesPricePerKilo),
        isDefault: u.IsDefault || false,
    }));

    const baseUnit = salesUnits.find(u => u.isDefault) || salesUnits[0];
    const cheapest = m.SalesUnits?.CheapestSalesUnitFormattedPrices;
    const wt = m.WeightKg || {};
    const img = m.Image || {};

    return {
        varenummer: String(m.Id),
        name: m.DisplayName || '',
        brand: m.Brand?.Value || null,
        gtin: m.GTIN ? String(m.GTIN) : null,

        pricePerUnit: baseUnit?.salesPrice || baseUnit?.listPrice || null,
        pricePerKg: parseDanishNumber(cheapest?.SalesPricePerKilo) || null,
        listPricePerKg: parseDanishNumber(cheapest?.ListPricePerKilo) || null,
        currency: 'DKK',
        salesUnits,

        netWeightKg: wt.Net || null,
        grossWeightKg: wt.Gross || null,
        baseUnitCode: m.SalesUnits?.BaseUnitCode || null,

        nutrition,

        co2e: m.Co2Equivalent || m.EnvironmentalImpact?.CO2Equivalent || null,

        isOrganic: deriveOrganic(m.Markings),
        countryCode: deriveCountry(m.Markings, m.CountryOfOrigin),
        markings: (m.Markings || []).map(mk => ({ name: mk.Value, code: mk.Id })),

        salesPriceSource: m.SalesPriceSource?.Text || null,
        isAgreementItem: m.SalesPriceSource?.TrackingId === 'Fixed',
        isOnFavoriteList: m.IsOnFavoriteList || false,

        url: m.Url ? `https://www.hoka.dk${m.Url}` : null,
        image: img.Medium || img.Small || null,
        imageSmall: img.Small || img.SmallRetina || null,
        manufacturer: m.Manufacturer?.Value || null,
        categories: parseCategories(m.Categories),

        scrapedAt: new Date().toISOString(),
    };
}

/**
 * Parse search results from /api/catalog/search?q=...
 */
function parseSearchResults(raw) {
    const page = raw?.Model?.Page;
    if (!page) throw new Error('Ugyldigt sge-svar: mangler Model.Page');

    const results = (page.PageOfResults || []).map(item => {
        const cheapest = item.SalesUnits?.CheapestSalesUnitFormattedPrices;
        return {
            varenummer: String(item.Id),
            name: item.DisplayName || '',
            brand: item.Brand?.Value || null,
            pricePerKg: parseDanishNumber(cheapest?.SalesPricePerKilo) || null,
            listPricePerKg: parseDanishNumber(cheapest?.ListPricePerKilo) || null,
            co2e: item.Co2Equivalent || null,
            image: item.Image?.Small || null,
            url: item.Url ? `https://www.hoka.dk${item.Url}` : null,
            isOnFavoriteList: item.IsOnFavoriteList || false,
            markings: (item.Markings || []).map(mk => ({ name: mk.Value, code: mk.Id })),
            isOrganic: deriveOrganic(item.Markings),
            salesPriceSource: null,
            isAgreementItem: false,
        };
    });

    return {
        totalResults: page.TotalNumberOfResults || results.length,
        pageSize: page.PageSize || results.length,
        results,
    };
}

/**
 * Parse favorite lists from /api/favorites + /api/navigation/favorites
 */
function parseFavoriteLists(customData, navData) {
    const lists = [];
    const navItems = navData?.Model || [];

    for (const item of navItems) {
        if (item.Type === 'navigation_separator' || item.Id === 'see_all_lists') continue;
        let listId = item.Id;
        if (listId === 'sales_statistics') listId = 'salesstatistics';
        const isGenerated = isNaN(parseInt(listId));
        lists.push({
            id: listId,
            name: item.Title || item.Name || 'Unavngivet',
            type: isGenerated ? 'generated' : 'custom',
        });
    }

    const existingIds = new Set(lists.map(l => l.id));
    const customLists = customData?.Model || [];
    for (const item of (Array.isArray(customLists) ? customLists : [])) {
        const id = String(item.Id);
        if (!existingIds.has(id)) {
            lists.push({ id, name: item.Name || 'Unavngivet', type: 'custom' });
        }
    }
    return { lists };
}

/**
 * Parse products from a favorite list response.
 */
function parseFavoriteProducts(raw, listId) {
    const model = raw?.Model;
    if (!model) throw new Error('Ugyldigt favorit-svar: mangler Model');
    const page = model.Page;
    if (!page) throw new Error('Ugyldigt favorit-svar: mangler Model.Page');

    const products = (page.PageOfResults || []).map(item => {
        const cheapest = item.SalesUnits?.CheapestSalesUnitFormattedPrices;
        const baseUnit = item.SalesUnits?.Values?.find(u => u.IsDefault) || item.SalesUnits?.Values?.[0];

        return {
            varenummer: String(item.Id),
            name: item.DisplayName || '',
            brand: item.Brand?.Value || null,
            pricePerUnit: baseUnit?.ListPrice || null,
            pricePerKg: parseDanishNumber(cheapest?.SalesPricePerKilo || cheapest?.ListPricePerKilo) || null,
            image: item.Image?.Small || null,
            url: item.Url ? `https://www.hoka.dk${item.Url}` : null,
            isOnFavoriteList: item.IsOnFavoriteList || false,
            markings: (item.Markings || []).map(mk => ({ name: mk.Value, code: mk.Id })),
            isOrganic: deriveOrganic(item.Markings),
            baseUnitCode: item.SalesUnits?.BaseUnitCode || null,
            salesPriceSource: null,
            isAgreementItem: false,
        };
    });

    return {
        listId,
        listName: model.Name || (listId === 'salesstatistics' ? 'Sidste 3 mdr. kb' : `Liste ${listId}`),
        totalResults: page.TotalResults || products.length,
        totalPages: page.TotalPages || 1,
        currentPage: page.CurrentPage || 1,
        products,
    };
}

/**
 * Parse a single snapshot into lightweight summary.
 */
function parseSnapshotToSummary(snap) {
    if (!snap) return null;

    const cheapest = snap.SalesUnits?.CheapestSalesUnitFormattedPrices;
    const baseUnit = snap.SalesUnits?.Values?.find(u => u.IsDefault) || snap.SalesUnits?.Values?.[0];

    const salesUnits = (snap.SalesUnits?.Values || []).map(u => ({
        code: u.Code,
        name: u.TextSingular,
        namePlural: u.TextPlural,
        quantity: u.Quantity,
        listPrice: u.ListPrice,
        salesPrice: parseDanishNumber(u.FormattedPrices?.SalesPricePerBaseUnit),
        isDefault: u.IsDefault || false,
    }));

    const wt = snap.WeightKg || {};

    return {
        varenummer: String(snap.Id),
        name: snap.DisplayName || '',
        brand: snap.Brand?.Value || null,

        pricePerUnit: baseUnit ? (parseDanishNumber(baseUnit.FormattedPrices?.SalesPricePerBaseUnit) || baseUnit.ListPrice) : null,
        pricePerKg: parseDanishNumber(cheapest?.SalesPricePerKilo) || null,
        salesUnits,

        netWeightKg: wt.Net || null,
        baseUnitCode: snap.SalesUnits?.BaseUnitCode || null,

        isOrganic: deriveOrganic(snap.Markings),
        markings: (snap.Markings || []).map(mk => ({ name: mk.Value, code: mk.Id })),

        salesPriceSource: snap.SalesPriceSource?.Text || null,
        isAgreementItem: snap.SalesPriceSource?.TrackingId === 'Fixed',

        co2e: snap.Co2Equivalent || snap.EnvironmentalImpact?.CO2Equivalent || null,

        image: snap.Image?.Small || null,
        url: snap.Url ? `https://www.hoka.dk${snap.Url}` : null,
    };
}

/* ── Helpers ──────────────────────────────────────────────── */

function parseNutrition(nutritions) {
    const result = { energyKj: null, energyKcal: null, fat: null, fatSaturated: null, carbs: null, sugar: null, fiber: null, protein: null, salt: null };
    for (const n of nutritions) {
        const text = (n.Text || '').toLowerCase();
        const amount = n.Amount;
        if (text.includes('kj')) result.energyKj = amount;
        else if (text.includes('kcal')) result.energyKcal = amount;
        else if (text.includes('fedt') || text === 'fat') {
            result.fat = amount;
            for (const child of (n.Children || [])) {
                if ((child.Text || '').toLowerCase().includes('mt')) result.fatSaturated = child.Amount;
            }
        }
        else if (text.includes('kulhydrat') || text.includes('carb')) {
            result.carbs = amount;
            for (const child of (n.Children || [])) {
                if ((child.Text || '').toLowerCase().includes('sukker')) result.sugar = child.Amount;
            }
        }
        else if (text.includes('kostfibre') || text.includes('fiber')) result.fiber = amount;
        else if (text.includes('protein')) result.protein = amount;
        else if (text.includes('salt')) result.salt = amount;
    }
    return result;
}

function parseCategories(categories) {
    if (!categories || !categories.length) return [];
    return categories.map(cat => {
        const parts = [];
        for (const level of ['Level1', 'Level2', 'Level3', 'Level4']) {
            if (cat[level]?.DisplayName) parts.push(cat[level].DisplayName);
        }
        return parts.join(' > ');
    });
}

function parseDanishNumber(str) {
    if (str == null) return null;
    const match = String(str).match(/([\d.,]+)/);
    if (!match) return null;
    const cleaned = match[1].replace(/\./g, '').replace(',', '.');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
}

function deriveOrganic(markings) {
    if (!markings || !markings.length) return false;
    return markings.some(mk =>
        (mk.Id || '').toLowerCase() === 'organic' ||
        (mk.Value || '').toLowerCase().includes('kologisk')
    );
}

function deriveCountry(markings, countryOfOrigin) {
    const countryCodes = ['dk', 'de', 'se', 'no', 'fi', 'nl', 'fr', 'it', 'es', 'be', 'at', 'pl', 'eu'];
    if (markings && markings.length) {
        for (const mk of markings) {
            const code = (mk.Id || '').toLowerCase();
            if (countryCodes.includes(code)) return code.toUpperCase();
        }
    }
    if (countryOfOrigin) {
        if (typeof countryOfOrigin === 'object') return (countryOfOrigin.Id || countryOfOrigin.Value || '').trim() || null;
        return String(countryOfOrigin).trim() || null;
    }
    return null;
}

module.exports = {
    parseProduct,
    parseSearchResults,
    parseFavoriteLists,
    parseFavoriteProducts,
    parseSnapshotToSummary,
    parseDanishNumber,
};
