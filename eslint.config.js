import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const coreTsFiles = ['crates/core/assets/js/**/*.ts'];
const typedTypeScriptConfigs = [
    ...tseslint.configs.strictTypeChecked,
].map((config) => ({
    ...config,
    files: coreTsFiles,
}));

export default tseslint.config(
    {
        ignores: [
            'node_modules/**',
            'target/**',
            'crates/core/assets/dist/**',
            'crates/gui/**',
        ],
    },
    js.configs.recommended,
    ...typedTypeScriptConfigs,
    {
        files: coreTsFiles,
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        rules: {
            'no-console': ['error', { allow: ['warn', 'error'] }],
            'no-undef': 'off',
            '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
            '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
            '@typescript-eslint/no-extraneous-class': 'off',
            '@typescript-eslint/no-unnecessary-condition': 'off',
            '@typescript-eslint/no-unnecessary-type-conversion': 'off',
            '@typescript-eslint/non-nullable-type-assertion-style': 'off',
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
            '@typescript-eslint/restrict-template-expressions': [
                'error',
                {
                    allowAny: false,
                    allowBoolean: true,
                    allowNullish: true,
                    allowNumber: true,
                    allowRegExp: false,
                },
            ],
        },
    },
    {
        files: ['crates/core/assets/js/**/*.test.ts'],
        rules: {
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-base-to-string': 'off',
            '@typescript-eslint/no-misused-spread': 'off',
            '@typescript-eslint/unbound-method': 'off',
        },
    },
    {
        files: ['crates/core/assets/js/core/utils.ts'],
        rules: {
            'no-console': 'off',
        },
    },
    {
        files: ['scripts/**/*.mjs', '*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.node,
        },
        rules: {
            'no-console': 'off',
        },
    },
);
