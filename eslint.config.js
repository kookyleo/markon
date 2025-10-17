export default [
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: {
                window: "readonly",
                document: "readonly",
                console: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
                localStorage: "readonly",
                location: "readonly",
                history: "readonly"
            }
        },
        rules: {
            "no-unused-vars": "warn",
            "no-undef": "error",
            "no-redeclare": "error",
            "no-unreachable": "warn",
            "semi": ["warn", "always"],
            "quotes": ["warn", "single", { "avoidEscape": true }],
            "indent": ["warn", 4],
            "no-console": "off"
        }
    }
];
