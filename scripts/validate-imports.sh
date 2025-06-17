#!/bin/bash

# Import validation script
# Checks that all imports are using the correct aliases

echo "🔍 Validating import aliases..."
echo ""

# Counter variables
errors=0
warnings=0

# Check for any remaining HTTPS imports
echo "Checking for remaining HTTPS imports..."
remaining_https=$(grep -r "https://deno\.land" --include="*.ts" . | grep -v "node_modules" | grep -v "dist" | grep -v "coverage" | grep -v "bin" | grep -v "// " | wc -l)

if [ $remaining_https -gt 0 ]; then
    echo "❌ Found $remaining_https files with HTTPS imports:"
    grep -r "https://deno\.land" --include="*.ts" . | grep -v "node_modules" | grep -v "dist" | grep -v "coverage" | grep -v "bin" | grep -v "// "
    ((errors++))
else
    echo "✅ No HTTPS imports found"
fi

echo ""

# Check for consistent import patterns
echo "Checking import consistency..."

# Check for mixed quotes in imports
mixed_quotes=$(grep -E "import.*from ['\"]@std.*['\"]" --include="*.ts" -r . | grep -v "node_modules" | wc -l)
if [ $mixed_quotes -gt 0 ]; then
    echo "⚠️  Found imports with mixed quote styles. Consider standardizing."
    ((warnings++))
fi

# Check for imports without proper aliases
echo ""
echo "Checking for imports without aliases..."

# Look for potential unaliased imports
unaliased=$(grep -E "from ['\"]\./|from ['\"]\.\./" --include="*.ts" -r . | grep -v "node_modules" | wc -l)
echo "ℹ️  Found $unaliased relative imports (this is normal for internal modules)"

echo ""
echo "📊 Summary:"
echo "  Errors: $errors"
echo "  Warnings: $warnings"
echo ""

if [ $errors -gt 0 ]; then
    echo "❌ Validation failed. Please fix the errors above."
    exit 1
else
    echo "✅ Import validation passed!"
    
    if [ $warnings -gt 0 ]; then
        echo "⚠️  There are $warnings warnings to consider."
    fi
fi

echo ""
echo "💡 Next steps:"
echo "  1. If using Deno, run: deno check --import-map=import-map.json src/**/*.ts"
echo "  2. Run tests to ensure everything works: deno test --import-map=import-map.json"
echo "  3. Update any build scripts to use the import map"