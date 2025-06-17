#!/bin/bash

# ESM URL Import Fix Script
# Converts HTTPS imports to import map aliases

echo "🔧 Fixing HTTPS imports in TypeScript files..."
echo ""

# Counter variables
total_files=0
fixed_files=0
total_fixes=0

# Temporary file for tracking changes
changes_file=$(mktemp)

# Function to fix imports in a single file
fix_file() {
    local file="$1"
    local temp_file=$(mktemp)
    local file_changed=false
    
    # Copy original file to temp
    cp "$file" "$temp_file"
    
    # Apply all replacements
    # Standard library imports - normalize to 0.224.0
    sed -i 's|https://deno\.land/std@0\.208\.0/testing/asserts\.ts|@std/assert|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.220\.0/assert/mod\.ts|@std/assert|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.224\.0/assert/mod\.ts|@std/assert|g' "$temp_file"
    
    sed -i 's|https://deno\.land/std@0\.208\.0/async/delay\.ts|@std/async|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.220\.0/async/delay\.ts|@std/async|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.224\.0/async/mod\.ts|@std/async|g' "$temp_file"
    
    sed -i 's|https://deno\.land/std@0\.208\.0/cli/parse_args\.ts|@std/cli|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.220\.0/cli/parse_args\.ts|@std/cli|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.224\.0/cli/parse_args\.ts|@std/cli|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.224\.0/cli/mod\.ts|@std/cli|g' "$temp_file"
    
    sed -i 's|https://deno\.land/std@0\.224\.0/flags/mod\.ts|@std/flags|g' "$temp_file"
    
    sed -i 's|https://deno\.land/std@0\.224\.0/fmt/colors\.ts|@std/fmt|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.224\.0/fmt/mod\.ts|@std/fmt|g' "$temp_file"
    
    sed -i 's|https://deno\.land/std@0\.208\.0/fs/mod\.ts|@std/fs|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.220\.0/fs/mod\.ts|@std/fs|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.224\.0/fs/mod\.ts|@std/fs|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.220\.0/fs/ensure_dir\.ts|@std/fs|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.220\.0/fs/exists\.ts|@std/fs|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.220\.0/fs/walk\.ts|@std/fs|g' "$temp_file"
    
    sed -i 's|https://deno\.land/std@0\.208\.0/path/mod\.ts|@std/path|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.220\.0/path/mod\.ts|@std/path|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.224\.0/path/mod\.ts|@std/path|g' "$temp_file"
    
    sed -i 's|https://deno\.land/std@0\.208\.0/testing/bdd\.ts|@std/testing/bdd|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.220\.0/testing/bdd\.ts|@std/testing/bdd|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.224\.0/testing/bdd\.ts|@std/testing/bdd|g' "$temp_file"
    
    sed -i 's|https://deno\.land/std@0\.220\.0/testing/mock\.ts|@std/testing/mock|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.224\.0/testing/mock\.ts|@std/testing/mock|g' "$temp_file"
    
    sed -i 's|https://deno\.land/std@0\.220\.0/testing/time\.ts|@std/testing/time|g' "$temp_file"
    sed -i 's|https://deno\.land/std@0\.224\.0/testing/time\.ts|@std/testing/time|g' "$temp_file"
    
    # SQLite
    sed -i 's|https://deno\.land/x/sqlite@v3\.8/mod\.ts|@sqlite|g' "$temp_file"
    
    # Cliffy
    sed -i 's|https://deno\.land/x/cliffy@v1\.0\.0-rc\.3/ansi/colors\.ts|@cliffy/ansi/colors|g' "$temp_file"
    
    # Check if file was changed
    if ! cmp -s "$file" "$temp_file"; then
        file_changed=true
        ((fixed_files++))
        
        # Count number of changes
        local changes=$(diff "$file" "$temp_file" | grep "^<" | wc -l)
        ((total_fixes += changes))
        
        # Record changes
        echo "📁 $file:" >> "$changes_file"
        diff --unified=0 "$file" "$temp_file" | grep -E "^[\+\-]import" | sed 's/^-/  - /; s/^+/  + /' >> "$changes_file"
        echo "" >> "$changes_file"
        
        # Apply changes
        mv "$temp_file" "$file"
    else
        rm "$temp_file"
    fi
}

# Find and process all TypeScript files
while IFS= read -r -d '' file; do
    ((total_files++))
    fix_file "$file"
done < <(find . -type f -name "*.ts" -not -path "./node_modules/*" -not -path "./dist/*" -not -path "./bin/*" -not -path "./coverage/*" -not -path "./test-results/*" -print0)

# Display summary
echo "✅ Processed $total_files files"
echo "📝 Fixed imports in $fixed_files files"
echo "🔄 Total fixes: $total_fixes"
echo ""

# Display detailed changes if any
if [ $fixed_files -gt 0 ]; then
    echo "📋 Import fixes applied:"
    echo ""
    cat "$changes_file"
fi

# Cleanup
rm "$changes_file"

echo "💡 Next steps:"
echo "  1. Run 'deno fmt' to ensure consistent formatting"
echo "  2. Run 'deno check src/**/*.ts' to verify type checking"
echo "  3. Run 'deno test' to ensure all tests pass"
echo ""
echo "⚠️  Note: Some imports may need manual adjustment:"
echo "  - Imports using different std versions have been normalized to 0.224.0"
echo "  - Named imports from submodules may need adjustment"
echo "  - Check that all @std/ imports resolve correctly"