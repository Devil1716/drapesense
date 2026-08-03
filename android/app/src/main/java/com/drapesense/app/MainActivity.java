package com.drapesense.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(DrapeSenseUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
