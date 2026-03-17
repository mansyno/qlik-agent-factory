/**
 * Unit tests for architect_classifier.js
 * Tests the fixes for Issues #1, #2, #5, #8 from the advisor feedback.
 * 
 * Run: node test_classifier_unit.js
 */

const { classifyData } = require('./architect_classifier');

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  ✓ ${message}`);
        passed++;
    } else {
        console.error(`  ✗ FAIL: ${message}`);
        failed++;
    }
}

async function runTests() {
    try {
        // ==========================================
        // Test 1: Part table must classify as DIMENSION
        // ==========================================
        console.log('\n=== Test 1: Part Table Classification ===');

        const partProfile = {
            tables: {
                Part: {
                    rowCount: 389,
                    fields: {
                        'Part ID': { name: 'Part ID', uniquenessRatio: 1, nullPercentage: 0, avgLength: 4.69, isNumeric: false, distinctCount: 389 },
                        'Part Barcode': { name: 'Part Barcode', uniquenessRatio: 0.671, nullPercentage: 0, avgLength: 11.53, isNumeric: false, distinctCount: 261 },
                        'Part Name': { name: 'Part Name', uniquenessRatio: 1, nullPercentage: 0, avgLength: 23.77, isNumeric: false, distinctCount: 389 },
                        'Brand Des': { name: 'Brand Des', uniquenessRatio: 0.0129, nullPercentage: 0, avgLength: 8.21, isNumeric: false, distinctCount: 5 },
                        'Category Level 1': { name: 'Category Level 1', uniquenessRatio: 0.018, nullPercentage: 0, avgLength: 7.14, isNumeric: false, distinctCount: 7 },
                        'Category Level 2': { name: 'Category Level 2', uniquenessRatio: 0.0566, nullPercentage: 0, avgLength: 10.49, isNumeric: false, distinctCount: 22 },
                        'Units in Carton': { name: 'Units in Carton', uniquenessRatio: 0.0514, nullPercentage: 0, avgLength: 1.56, isNumeric: true, distinctCount: 20 },
                        'Cost': { name: 'Cost', uniquenessRatio: 0.0308, nullPercentage: 0, avgLength: 1.54, isNumeric: true, distinctCount: 12 }
                    }
                }
            }
        };

        const partResult = await classifyData(partProfile);
        const partClass = partResult.classifications.find(c => c.tableName === 'Part');

        assert(partClass.role === 'DIMENSION', 'Part should be DIMENSION (not FACT)');
        assert(partClass.fieldClassifications['Cost'].type === 'ATTRIBUTE', 'Part.Cost should be ATTRIBUTE (not MEASURE) — no FK pattern in table');
        assert(partClass.fieldClassifications['Part ID'].type === 'IDENTIFIER', 'Part.Part ID should be IDENTIFIER');
        assert(partClass.fieldClassifications['Part Name'].type === 'ATTRIBUTE', 'Part.Part Name should be ATTRIBUTE (not IDENTIFIER — no ID suffix)');

        // ==========================================
        // Test 2: Cities field classification
        // ==========================================
        console.log('\n=== Test 2: Cities Field Classification ===');

        const citiesProfile = {
            tables: {
                Cities: {
                    rowCount: 169,
                    fields: {
                        'City ID': { name: 'City ID', uniquenessRatio: 1, nullPercentage: 0, avgLength: 5.86, isNumeric: true, distinctCount: 169 },
                        'City': { name: 'City', uniquenessRatio: 1, nullPercentage: 0, avgLength: 8.72, isNumeric: false, distinctCount: 169 },
                        'latitude': { name: 'latitude', uniquenessRatio: 0.9822, nullPercentage: 0, avgLength: 12.22, isNumeric: true, distinctCount: 166 },
                        'longitude': { name: 'longitude', uniquenessRatio: 0.9822, nullPercentage: 0, avgLength: 11.74, isNumeric: true, distinctCount: 166 },
                        'Region ID': { name: 'Region ID', uniquenessRatio: 0.0473, nullPercentage: 0, avgLength: 1, isNumeric: true, distinctCount: 8 }
                    }
                }
            }
        };

        const citiesResult = await classifyData(citiesProfile);
        const citiesClass = citiesResult.classifications.find(c => c.tableName === 'Cities');

        assert(citiesClass.fieldClassifications['City ID'].type === 'IDENTIFIER', 'City ID should be IDENTIFIER');
        assert(citiesClass.fieldClassifications['City'].type === 'ATTRIBUTE', 'City should be ATTRIBUTE (not IDENTIFIER — no ID suffix, just unique name)');
        assert(citiesClass.fieldClassifications['latitude'].type === 'ATTRIBUTE', 'latitude should be ATTRIBUTE (not IDENTIFIER)');
        assert(citiesClass.fieldClassifications['longitude'].type === 'ATTRIBUTE', 'longitude should be ATTRIBUTE (not IDENTIFIER)');
        assert(citiesClass.fieldClassifications['Region ID'].type === 'IDENTIFIER', 'Region ID should be IDENTIFIER (FK)');
        assert(citiesClass.role === 'DIMENSION', 'Cities should be DIMENSION');

        // ==========================================
        // Test 3: CustomerOrders must be FACT with confirmed measures
        // ==========================================
        console.log('\n=== Test 3: CustomerOrders Classification ===');

        const coProfile = {
            tables: {
                CustomerOrders: {
                    rowCount: 62525,
                    fields: {
                        'Order Number': { name: 'Order Number', uniquenessRatio: 0.0154, nullPercentage: 0, avgLength: 11, isNumeric: false, distinctCount: 960 },
                        'Order Line': { name: 'Order Line', uniquenessRatio: 0.0036, nullPercentage: 0, avgLength: 1.95, isNumeric: true, distinctCount: 226 },
                        'Date': { name: 'Date', uniquenessRatio: 0.0066, nullPercentage: 0, avgLength: 10, isNumeric: false, distinctCount: 413 },
                        'Customer ID': { name: 'Customer ID', uniquenessRatio: 0.0154, nullPercentage: 0, avgLength: 3.78, isNumeric: true, distinctCount: 960 },
                        'Part ID': { name: 'Part ID', uniquenessRatio: 0.0061, nullPercentage: 0, avgLength: 4.63, isNumeric: true, distinctCount: 379 },
                        'Qnt': { name: 'Qnt', uniquenessRatio: 0.0272, nullPercentage: 0, avgLength: 1.6, isNumeric: true, distinctCount: 1701 },
                        'Price': { name: 'Price', uniquenessRatio: 0.0061, nullPercentage: 0, avgLength: 17.41, isNumeric: true, distinctCount: 379 },
                        'Total Amount': { name: 'Total Amount', uniquenessRatio: 0.2554, nullPercentage: 0, avgLength: 17.36, isNumeric: true, distinctCount: 15972 }
                    }
                }
            }
        };

        const coResult = await classifyData(coProfile);
        const coClass = coResult.classifications.find(c => c.tableName === 'CustomerOrders');

        assert(coClass.role === 'FACT', 'CustomerOrders should be FACT');
        assert(coClass.fieldClassifications['Price'].type === 'MEASURE', 'Price should be MEASURE (table has FKs = transactional)');
        assert(coClass.fieldClassifications['Total Amount'].type === 'MEASURE', 'Total Amount should be MEASURE');
        assert(coClass.fieldClassifications['Customer ID'].type === 'IDENTIFIER', 'Customer ID should be IDENTIFIER');
        assert(coClass.fieldClassifications['Part ID'].type === 'IDENTIFIER', 'Part ID should be IDENTIFIER');
        assert(coClass.fieldClassifications['Date'].type === 'DATE', 'Date should be DATE');

        // ==========================================
        // Test 4: Structured grain output
        // ==========================================
        console.log('\n=== Test 4: Structured Grain ===');

        assert(typeof partClass.grain === 'object', 'Grain should be an object (not string)');
        assert(Array.isArray(partClass.grain.primaryKey), 'Grain should have primaryKey array');
        assert(Array.isArray(partClass.grain.foreignKeys), 'Grain should have foreignKeys array');
        assert(partClass.grain.primaryKey.includes('Part ID'), 'Part grain PK should include Part ID');

        assert(typeof coClass.grain === 'object', 'CustomerOrders grain should be an object');
        // Customer ID and Part ID are FKs (low uniqueness ratio)
        assert(coClass.grain.foreignKeys.includes('Customer ID'), 'CustomerOrders FKs should include Customer ID');
        assert(coClass.grain.foreignKeys.includes('Part ID'), 'CustomerOrders FKs should include Part ID');

        // ==========================================
        // Test 5: LorriesCost — Cost should be ATTRIBUTE on a 4-row lookup  
        // ==========================================
        console.log('\n=== Test 5: LorriesCost Classification ===');

        const lcProfile = {
            tables: {
                LorriesCost: {
                    rowCount: 4,
                    fields: {
                        'Lorry_Type': { name: 'Lorry_Type', uniquenessRatio: 1, nullPercentage: 0, avgLength: 4.75, isNumeric: false, distinctCount: 4 },
                        'Cost': { name: 'Cost', uniquenessRatio: 1, nullPercentage: 0, avgLength: 4, isNumeric: true, distinctCount: 4 }
                    }
                }
            }
        };

        const lcResult = await classifyData(lcProfile);
        const lcClass = lcResult.classifications.find(c => c.tableName === 'LorriesCost');

        assert(lcClass.role === 'DIMENSION', 'LorriesCost should be DIMENSION');
        assert(lcClass.fieldClassifications['Cost'].type === 'ATTRIBUTE', 'LorriesCost.Cost should be ATTRIBUTE — only 4 rows, no FK pattern');

    } catch (err) {
        console.error("Test Error:", err);
        failed++;
    }

    // ==========================================
    // Summary
    // ==========================================
    console.log(`\n========================================`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`========================================`);
    if (failed > 0) process.exit(1);
}

runTests();
