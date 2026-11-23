package com.gitedge.signing;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.InvalidKeyException;
import java.security.InvalidParameterException;
import java.security.Key;
import java.security.KeyStoreException;
import java.security.KeyStoreSpi;
import java.security.PrivateKey;
import java.security.Provider;
import java.security.PublicKey;
import java.security.Security;
import java.security.SignatureException;
import java.security.SignatureSpi;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Date;
import java.util.Enumeration;
import java.util.List;
import java.util.Properties;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * JCA provider that signs through the GitEdge signing endpoints, so the private key never leaves the
 * server. apksigner instantiates it with the path of a properties file holding the request endpoint
 * and the lease credentials.
 */
public final class RemoteProvider extends Provider {
  private static final long serialVersionUID = 1L;
  private static final String ALIAS = "signer";
  private static final int MAX_SIGN_BYTES = 8 * 1024 * 1024;
  private static final Pattern STRING = Pattern.compile("\"([A-Za-z0-9+/=_-]+)\"");

  private final transient Remote remote;

  public RemoteProvider(String configPath) throws IOException {
    super("GitEdgeRemote", "1.0", "GitEdge remote signing");
    Properties config = new Properties();
    try (InputStream in = Files.newInputStream(Path.of(configPath))) {
      config.load(in);
    }
    this.remote = new Remote(config);
    putService(new Service(this, "KeyStore", "GITEDGE", RemoteKeyStore.class.getName(), null, null) {
      @Override
      public Object newInstance(Object parameter) {
        return new RemoteKeyStore(remote);
      }
    });
    for (String[] algorithm : new String[][] {
      {"SHA1withRSA", "SHA-1", "RSA"},
      {"SHA256withRSA", "SHA-256", "RSA"},
      {"SHA384withRSA", "SHA-384", "RSA"},
      {"SHA512withRSA", "SHA-512", "RSA"},
      {"SHA1withECDSA", "SHA-1", "EC"},
      {"SHA256withECDSA", "SHA-256", "EC"},
      {"SHA384withECDSA", "SHA-384", "EC"},
      {"SHA512withECDSA", "SHA-512", "EC"},
    }) {
      String hash = algorithm[1];
      putService(
          new Service(
              this,
              "Signature",
              algorithm[0],
              RemoteSignature.class.getName(),
              null,
              Collections.singletonMap("SupportedKeyClasses", RemoteKey.class.getName())) {
            @Override
            public Object newInstance(Object parameter) {
              return new RemoteSignature(remote, hash);
            }

            @Override
            public boolean supportsParameter(Object parameter) {
              return parameter instanceof RemoteKey;
            }
          });
    }
    Security.insertProviderAt(this, 1);
  }

  static final class Remote {
    private final String endpoint;
    private final String jobToken;
    private final String runId;
    private final String leaseToken;
    private final HttpClient client =
        HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(30)).build();
    private Signer signer;

    Remote(Properties config) {
      endpoint = config.getProperty("endpoint");
      jobToken = config.getProperty("jobToken");
      runId = config.getProperty("runId");
      leaseToken = config.getProperty("leaseToken");
      if (endpoint == null || jobToken == null || runId == null || leaseToken == null)
        throw new IllegalArgumentException("remote signing configuration is incomplete");
    }

    private HttpRequest.Builder request(String action) {
      return HttpRequest.newBuilder(URI.create(endpoint + "/" + action))
          .timeout(Duration.ofSeconds(120))
          .header("Authorization", "Bearer " + jobToken)
          .header("X-Runner-Run-Id", runId)
          .header("X-Runner-Lease-Token", leaseToken)
          .header("Accept", "application/json");
    }

    private String send(HttpRequest request) throws IOException {
      IOException failure = null;
      for (int attempt = 0; attempt < 4; attempt++) {
        try {
          HttpResponse<String> response =
              client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
          int status = response.statusCode();
          if (status == 200) return response.body();
          failure = new IOException("remote signing request failed with status " + status);
          if (status != 502 && status != 503 && status != 504) throw failure;
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
          throw new IOException("remote signing request interrupted", e);
        } catch (IOException e) {
          failure = e;
          if (e.getMessage() != null && e.getMessage().startsWith("remote signing request failed with status 4"))
            throw e;
        }
        try {
          Thread.sleep(500L << attempt);
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
          throw new IOException("remote signing request interrupted", e);
        }
      }
      throw failure;
    }

    synchronized Signer signer() throws IOException {
      if (signer != null) return signer;
      String body = send(request("signer").GET().build());
      Matcher type = Pattern.compile("\"keyType\"\\s*:\\s*\"([a-z0-9-]+)\"").matcher(body);
      Matcher chain = Pattern.compile("\"chain\"\\s*:\\s*\\[([^\\]]*)\\]").matcher(body);
      if (!type.find() || !chain.find()) throw new IOException("signer response is invalid");
      String keyType = type.group(1);
      String algorithm = keyType.equals("rsa") ? "RSA" : keyType.startsWith("ec-") ? "EC" : null;
      if (algorithm == null) throw new IOException("signer key type is unsupported");
      List<X509Certificate> certificates = new ArrayList<>();
      try {
        CertificateFactory factory = CertificateFactory.getInstance("X.509");
        Matcher item = STRING.matcher(chain.group(1));
        while (item.find()) {
          byte[] der = Base64.getDecoder().decode(item.group(1));
          certificates.add((X509Certificate) factory.generateCertificate(new ByteArrayInputStream(der)));
        }
      } catch (Exception e) {
        throw new IOException("signer certificate chain is invalid", e);
      }
      if (certificates.isEmpty()) throw new IOException("signer certificate chain is empty");
      signer = new Signer(new RemoteKey(algorithm), certificates.toArray(new Certificate[0]));
      return signer;
    }

    byte[] sign(byte[] data, String hash, String algorithm) throws IOException {
      String body =
          "{\"data\":\""
              + Base64.getEncoder().encodeToString(data)
              + "\",\"hash\":\""
              + hash
              + "\",\"format\":\"der\"}";
      String response =
          send(
              request("sign")
                  .header("Content-Type", "application/json")
                  .POST(HttpRequest.BodyPublishers.ofString(body))
                  .build());
      Matcher signature = Pattern.compile("\"signature\"\\s*:\\s*\"([A-Za-z0-9+/=]+)\"").matcher(response);
      if (!signature.find()) throw new IOException("sign response is invalid");
      return Base64.getDecoder().decode(signature.group(1));
    }
  }

  static final class Signer {
    final RemoteKey key;
    final Certificate[] chain;

    Signer(RemoteKey key, Certificate[] chain) {
      this.key = key;
      this.chain = chain;
    }
  }

  /** Not an RSAPrivateKey or ECPrivateKey, so only this provider accepts it. */
  public static final class RemoteKey implements PrivateKey {
    private static final long serialVersionUID = 1L;
    private final String algorithm;

    RemoteKey(String algorithm) {
      this.algorithm = algorithm;
    }

    @Override
    public String getAlgorithm() {
      return algorithm;
    }

    @Override
    public String getFormat() {
      return null;
    }

    @Override
    public byte[] getEncoded() {
      return null;
    }
  }

  public static final class RemoteSignature extends SignatureSpi {
    private final Remote remote;
    private final String hash;
    private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    private RemoteKey key;

    RemoteSignature(Remote remote, String hash) {
      this.remote = remote;
      this.hash = hash;
    }

    @Override
    protected void engineInitVerify(PublicKey publicKey) throws InvalidKeyException {
      throw new InvalidKeyException("verification is not supported");
    }

    @Override
    protected void engineInitSign(PrivateKey privateKey) throws InvalidKeyException {
      if (!(privateKey instanceof RemoteKey)) throw new InvalidKeyException("unsupported key");
      key = (RemoteKey) privateKey;
      buffer.reset();
    }

    @Override
    protected void engineUpdate(byte b) throws SignatureException {
      engineUpdate(new byte[] {b}, 0, 1);
    }

    @Override
    protected void engineUpdate(byte[] b, int off, int len) throws SignatureException {
      if (buffer.size() + len > MAX_SIGN_BYTES) throw new SignatureException("data is too large");
      buffer.write(b, off, len);
    }

    @Override
    protected byte[] engineSign() throws SignatureException {
      try {
        byte[] data = buffer.toByteArray();
        buffer.reset();
        return remote.sign(data, hash, key.getAlgorithm());
      } catch (IOException e) {
        throw new SignatureException(e.getMessage(), e);
      }
    }

    @Override
    protected boolean engineVerify(byte[] sigBytes) throws SignatureException {
      throw new SignatureException("verification is not supported");
    }

    @Override
    @Deprecated
    protected void engineSetParameter(String param, Object value) {
      throw new InvalidParameterException("parameters are not supported");
    }

    @Override
    @Deprecated
    protected Object engineGetParameter(String param) {
      throw new InvalidParameterException("parameters are not supported");
    }
  }

  public static final class RemoteKeyStore extends KeyStoreSpi {
    private final Remote remote;

    RemoteKeyStore(Remote remote) {
      this.remote = remote;
    }

    private Signer signer() {
      try {
        return remote.signer();
      } catch (IOException e) {
        throw new IllegalStateException(e.getMessage(), e);
      }
    }

    @Override
    public Key engineGetKey(String alias, char[] password) {
      return ALIAS.equalsIgnoreCase(alias) ? signer().key : null;
    }

    @Override
    public Certificate[] engineGetCertificateChain(String alias) {
      return ALIAS.equalsIgnoreCase(alias) ? signer().chain.clone() : null;
    }

    @Override
    public Certificate engineGetCertificate(String alias) {
      return ALIAS.equalsIgnoreCase(alias) ? signer().chain[0] : null;
    }

    @Override
    public Date engineGetCreationDate(String alias) {
      return ALIAS.equalsIgnoreCase(alias) ? new Date(0) : null;
    }

    @Override
    public Enumeration<String> engineAliases() {
      return Collections.enumeration(Collections.singletonList(ALIAS));
    }

    @Override
    public boolean engineContainsAlias(String alias) {
      return ALIAS.equalsIgnoreCase(alias);
    }

    @Override
    public int engineSize() {
      return 1;
    }

    @Override
    public boolean engineIsKeyEntry(String alias) {
      return ALIAS.equalsIgnoreCase(alias);
    }

    @Override
    public boolean engineIsCertificateEntry(String alias) {
      return false;
    }

    @Override
    public String engineGetCertificateAlias(Certificate cert) {
      return null;
    }

    @Override
    public void engineSetKeyEntry(String alias, Key key, char[] password, Certificate[] chain)
        throws KeyStoreException {
      throw new KeyStoreException("read only");
    }

    @Override
    public void engineSetKeyEntry(String alias, byte[] key, Certificate[] chain)
        throws KeyStoreException {
      throw new KeyStoreException("read only");
    }

    @Override
    public void engineSetCertificateEntry(String alias, Certificate cert) throws KeyStoreException {
      throw new KeyStoreException("read only");
    }

    @Override
    public void engineDeleteEntry(String alias) throws KeyStoreException {
      throw new KeyStoreException("read only");
    }

    @Override
    public void engineStore(OutputStream stream, char[] password) throws IOException {
      throw new IOException("read only");
    }

    @Override
    public void engineLoad(InputStream stream, char[] password) throws IOException {
      remote.signer();
    }
  }
}
