package com.drapesense.app;

import android.content.Intent;
import android.net.Uri;
import android.webkit.URLUtil;

import androidx.core.content.FileProvider;

import com.getcapacitor.Bridge;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

@CapacitorPlugin(name = "DrapeSenseUpdater")
public class DrapeSenseUpdaterPlugin extends Plugin {

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String downloadUrl = call.getString("url");
        if (downloadUrl == null || !URLUtil.isHttpsUrl(downloadUrl)) {
            call.reject("A secure APK download URL is required.");
            return;
        }

        new Thread(() -> {
            try {
                File apk = downloadApk(downloadUrl);
                getActivity().runOnUiThread(() -> {
                    try {
                        Uri apkUri = FileProvider.getUriForFile(
                                getContext(),
                                getContext().getPackageName() + ".fileprovider",
                                apk
                        );
                        Intent installIntent = new Intent(Intent.ACTION_VIEW);
                        installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                        installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                        getContext().startActivity(installIntent);
                        call.resolve();
                    } catch (Exception error) {
                        call.reject("Could not open the Android installer.", error);
                    }
                });
            } catch (Exception error) {
                call.reject("Could not download the update.", error);
            }
        }).start();
    }

    private File downloadApk(String downloadUrl) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(downloadUrl).openConnection();
        connection.setInstanceFollowRedirects(true);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(60000);
        connection.setRequestProperty("User-Agent", "DrapeSense-Updater");
        connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
        if (connection.getResponseCode() < 200 || connection.getResponseCode() >= 300) {
            throw new IllegalStateException("Update server returned HTTP " + connection.getResponseCode());
        }

        File apk = new File(getContext().getCacheDir(), "drapesense-update.apk");
        try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(apk)) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        } finally {
            connection.disconnect();
        }
        return apk;
    }
}
