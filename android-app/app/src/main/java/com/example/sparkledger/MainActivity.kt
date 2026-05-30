package com.example.sparkledger

import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import android.app.Activity

class MainActivity : Activity() {
  private lateinit var webView: WebView

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    
    webView = WebView(this).apply {
      settings.javaScriptEnabled = true
      settings.domStorageEnabled = true
      settings.allowFileAccess = true
      settings.allowContentAccess = true
      settings.databaseEnabled = true
      settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
      
      webViewClient = WebViewClient()
      webChromeClient = WebChromeClient()
    }
    
    setContentView(webView)
    webView.loadUrl("file:///android_asset/index.html")
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    if (::webView.isInitialized && webView.canGoBack()) {
      webView.goBack()
    } else {
      @Suppress("DEPRECATION")
      super.onBackPressed()
    }
  }
}
